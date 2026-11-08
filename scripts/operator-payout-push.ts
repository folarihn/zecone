// Report an operator-approved Base payout to the payment API when the watcher
// (and its operator mirror) runs on another host. The payout journals, pilot
// sessions, keys and signed bytes never leave the operator machine; only the
// verified payout transaction hash and amount are sent.
//
// It reuses the exact settlement check the local sync runs: the order is copied
// into a throwaway in-memory store, `recordCheckoutPayoutFromSession` verifies
// the pilot session, its plan terms and the submission journal against that
// order, and only a submitted or completed outcome is pushed.
//
// npm run operator:payout -- --remote http://127.0.0.1:14322 \
//   --token-file <protected/operator-token.txt> --order-id <pay_...> \
//   --submission-journal <submissions.sqlite> --pilot-journal <pilot-sessions.sqlite> \
//   --sessions-directory <sessions>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { httpRemote } from "./operator-sync.ts";
import { PaymentStore } from "../services/payments/store.ts";
import {
  recordCheckoutPayoutFromSession,
  type CheckoutSettlementSessionPaths,
} from "../services/payments/checkout-settlement.ts";

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--"))
    throw Error(`MISSING_${name.toUpperCase().replace(/-/g, "_")}`);
  return value;
}

/** Verify the order's payout from local journals and report it; exported for tests. */
export async function pushPayout(
  remote: Pick<ReturnType<typeof httpRemote>, "orders" | "payout">,
  orderId: string,
  paths: CheckoutSettlementSessionPaths,
  now = Math.floor(Date.now() / 1000),
): Promise<
  | { ok: true; status: "submitted" | "completed"; payoutTxHash: string }
  | { ok: false; status: string }
> {
  if (!/^pay_[a-f0-9]{26}$/.test(orderId)) throw Error("ORDER_ID_INVALID");
  const order = (await remote.orders()).find((o) => o.id === orderId);
  if (!order) throw Error("REAL_ORDER_NOT_FOUND");
  const store = new PaymentStore(":memory:");
  try {
    store.mirrorPayment(order);
    // The mirror normally rebuilds evidence from its own watcher. Here the
    // watcher runs on the API host, so take the authenticated evidence the API
    // holds; the settlement check still binds it to the locally signed pilot
    // session, plan terms and submission journal.
    if (order.evidenceKind !== "mainnet-observed")
      throw Error("ORDER_NOT_MAINNET_OBSERVED");
    store.db
      .prepare(
        `UPDATE payments SET detected_txid=?, detected_zat=?, evidence_kind=?,
           chain_evidence_json=?, confirmations=?, wallet_evidence_json=? WHERE id=?`,
      )
      .run(
        order.detectedTxid,
        order.detectedZat,
        order.evidenceKind,
        order.chainEvidence ? JSON.stringify(order.chainEvidence) : null,
        order.confirmations,
        order.walletEvidence ? JSON.stringify(order.walletEvidence) : null,
        orderId,
      );
    const outcome = recordCheckoutPayoutFromSession(store, orderId, paths, now);
    if (outcome.status !== "submitted" && outcome.status !== "completed")
      return { ok: false, status: outcome.status };
    const m = store.getPayment(orderId)!;
    if (!m.payoutTxHash || !m.payoutWei) throw Error("PAYOUT_NOT_RECORDED");
    await remote.payout(orderId, { txHash: m.payoutTxHash, wei: m.payoutWei });
    return { ok: true, status: outcome.status, payoutTxHash: m.payoutTxHash };
  } finally {
    store.db.close();
  }
}

async function main() {
  const token = readFileSync(resolve(arg("token-file")), "utf8").trim();
  if (token.length < 48) throw Error("OPERATOR_TOKEN_INVALID");
  const orderId = arg("order-id");
  const result = await pushPayout(httpRemote(arg("remote"), token), orderId, {
    submissionJournal: resolve(arg("submission-journal")),
    pilotJournal: resolve(arg("pilot-journal")),
    sessionsDirectory: resolve(arg("sessions-directory")),
  });
  process.stdout.write(JSON.stringify({ orderId, ...result }) + "\n");
  if (!result.ok) process.exitCode = 2;
}

if (process.argv[1]?.endsWith("operator-payout-push.ts"))
  main().catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        error:
          error instanceof Error && /^[A-Z0-9_]{1,96}$/.test(error.message)
            ? error.message
            : "PAYOUT_PUSH_FAILED",
      }) + "\n",
    );
    process.exitCode = 1;
  });
