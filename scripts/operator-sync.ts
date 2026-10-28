// Operator-side sync for the restricted public mainnet pilot. Runs on the operator
// machine, where the UFVK watch wallet and authenticated block corpus live.
//
//   1. pulls the public API's open real orders (through an SSH tunnel to the
//      VPS loopback operator listener) into a local mirror store;
//   2. runs the EXISTING PaymentWatchBridge on that mirror (native scanner, two
//      providers, attribution, 20-confirmation verifyOwnedNote);
//   3. pushes the verified watcher tip, detection/confirmation progress and,
//      after the existing payout session + `checkout:settlement record`, the
//      Base payout back to the public API, which re-verifies it on Base.
// It never signs, broadcasts or opens a keystore, and sends no viewing key.
//
//   npm run operator:sync -- --remote http://127.0.0.1:14322 --token-file <protected/operator-token.txt> \
//     --mirror D:/zecone-mainnet/operator-mirror.sqlite --watch-worker-config <protected/watch-worker.json> \
//     --checkout-address <u1...> [--once] [--interval 120]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PaymentStore } from "../services/payments/store.ts";
import {
  PaymentWatchBridge,
  watcherFromWorkerConfig,
} from "../services/payments/watch-bridge.ts";
import { assertLoopbackApi } from "../services/payments/merchant-register.ts";
import type { Payment } from "../services/payments/types.ts";

const now = () => Math.floor(Date.now() / 1000);
function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (!v || v.startsWith("--"))
    throw Error(`MISSING_${name.toUpperCase().replace(/-/g, "_")}`);
  return v;
}

export interface Remote {
  orders(): Promise<Payment[]>;
  heartbeat(b: Record<string, unknown>): Promise<unknown>;
  observe(id: string, b: Record<string, unknown>): Promise<unknown>;
  payout(id: string, b: Record<string, unknown>): Promise<unknown>;
}

export function httpRemote(
  base: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Remote {
  const api = assertLoopbackApi(base);
  const call = async (path: string, body?: unknown) => {
    const r = await fetcher(new URL(path, api), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, any>;
    if (!r.ok)
      throw Error(
        `REMOTE_${String(j?.error?.code ?? r.status)
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, "_")}`,
      );
    return j;
  };
  return {
    orders: async () =>
      (await call("/api/v1/operator/real-orders")).orders as Payment[],
    heartbeat: (b) => call("/api/v1/operator/watcher/heartbeat", b),
    observe: (id, b) =>
      call(
        `/api/v1/operator/real-orders/${encodeURIComponent(id)}/observation`,
        b,
      ),
    payout: (id, b) =>
      call(`/api/v1/operator/real-orders/${encodeURIComponent(id)}/payout`, b),
  };
}

const CONFIRMED_OR_LATER = new Set([
  "ZEC_CONFIRMED",
  "PAYOUT_PENDING",
  "PAYOUT_SUBMITTED",
  "PAYOUT_CONFIRMED",
  "COMPLETED",
]);
const OBSERVABLE_REMOTE = new Set([
  "AWAITING_PAYMENT",
  "PAYMENT_DETECTED",
  "VERIFYING",
  "ZEC_CONFIRMED",
]);

/** One sync cycle. Exported for tests; `bridge` is the existing watcher bridge over `mirror`. */
export async function syncOnce(
  mirror: PaymentStore,
  bridge: { tick(): Promise<{ ok: boolean; error?: string }> },
  remote: Remote,
  t = now(),
) {
  const pushed: string[] = [];
  const remoteOrders = new Map((await remote.orders()).map((p) => [p.id, p]));
  for (const p of remoteOrders.values())
    if (p.mode === "monitor") mirror.mirrorPayment(p);
  mirror.expireDue(t);
  // Orders the public API no longer lists while still unpaid here were canceled or expired there.
  for (const r of mirror.db
    .prepare(`SELECT id FROM payments WHERE state='AWAITING_PAYMENT'`)
    .all() as { id: string }[])
    if (!remoteOrders.has(r.id))
      mirror.transition(r.id, "EXPIRED", { reason: "closed_on_public_api" }, t);

  const tick = await bridge.tick();
  if (!tick.ok) return { ok: false, error: tick.error, pushed };
  const cp = mirror.db
    .prepare(`SELECT * FROM watch_checkpoint WHERE id=1`)
    .get() as
    | {
        tip: number;
        block_hash: string;
        source: string;
        peer_source: string;
        observed_at: number;
      }
    | undefined;
  if (cp)
    await remote.heartbeat({
      tip: cp.tip,
      tipHash: cp.block_hash,
      source: cp.source,
      peerSource: cp.peer_source,
      observedAt: cp.observed_at,
    });

  for (const r of remoteOrders.values()) {
    const m = mirror.getPayment(r.id);
    if (!m) continue;
    if (m.state === "MANUAL_REVIEW" && r.state !== "MANUAL_REVIEW") {
      const reason = [...mirror.listEvents(m.id)]
        .reverse()
        .find((e) => e.state === "MANUAL_REVIEW")?.data.reason;
      await remote.observe(m.id, {
        state: "MANUAL_REVIEW",
        reason: typeof reason === "string" ? reason : "operator_review",
      });
      pushed.push(`${m.id}:MANUAL_REVIEW`);
      continue;
    }
    if (m.detectedTxid && m.chainEvidence && OBSERVABLE_REMOTE.has(r.state)) {
      const state = CONFIRMED_OR_LATER.has(m.state)
        ? "ZEC_CONFIRMED"
        : "VERIFYING";
      if (
        r.state !== state ||
        r.confirmations !== m.chainEvidence.confirmations
      ) {
        await remote.observe(m.id, {
          state,
          txid: m.detectedTxid,
          zat: m.detectedZat,
          chainEvidence: m.chainEvidence,
        });
        pushed.push(`${m.id}:${state}`);
      }
    }
    // Recorded by `checkout:settlement record` from the existing submission journal.
    if (
      m.payoutTxHash &&
      m.payoutWei &&
      (r.payoutTxHash === null ||
        (m.state === "COMPLETED" && r.state !== "COMPLETED"))
    ) {
      await remote.payout(m.id, { txHash: m.payoutTxHash, wei: m.payoutWei });
      pushed.push(`${m.id}:PAYOUT`);
    }
  }
  return { ok: true, pushed };
}

async function main() {
  const remote = httpRemote(
    arg("remote"),
    readFileSync(resolve(arg("token-file")), "utf8").trim(),
  );
  const mirror = new PaymentStore(resolve(arg("mirror")));
  const w = watcherFromWorkerConfig(
    resolve(arg("watch-worker-config")),
    arg("checkout-address"),
  );
  const bridge = new PaymentWatchBridge(mirror, w.source, {
    receivingAddress: arg("checkout-address"),
    minimumConfirmations: w.minimumConfirmations,
    lock: w.lock,
  });
  const once = process.argv.includes("--once");
  const interval = Math.max(60, Number(arg("interval", "120")));
  try {
    for (;;) {
      try {
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            ...(await syncOnce(mirror, bridge, remote)),
          }),
        );
      } catch (e) {
        console.error(
          JSON.stringify({
            at: new Date().toISOString(),
            error:
              e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
                ? e.message
                : "SYNC_FAILED",
          }),
        );
      }
      if (once) break;
      await new Promise((r) => setTimeout(r, interval * 1000));
    }
  } finally {
    mirror.close();
  }
}

if (process.argv[1] && /operator-sync\.ts$/.test(process.argv[1])) void main();
