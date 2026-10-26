// Monitor mode: the payment API consumes the REAL MainnetWatchScanner (driven by a
// fake observe-mainnet executable) and attributes real-format shielded notes to
// checkouts. Covers readiness gating, single-active-checkout, notes that predate
// a checkout, confirmations, evidence, webhooks/SSE, amount mismatch, duplicates,
// reorganization, provider failure, restart safety and demo/monitor isolation.
// Synthetic chain only — no network, keys or funds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onboard, startHarness, type Harness } from "./helpers/payments-harness.ts";
import { fakeWatcher, type FakeChain } from "./helpers/fake-watcher.ts";
import { createPaymentsApp, DEFAULT_CHECKOUT_ADDRESS, type PaymentsConfig } from "../services/payments/api.ts";
import { PaymentStore } from "../services/payments/store.ts";
import { replayStep } from "../services/payments/demo.ts";
import { verifySignature } from "../services/payments/webhooks.ts";

const ADDR = DEFAULT_CHECKOUT_ADDRESS;
const realNow = () => Math.floor(Date.now() / 1000);
const tx = (c: string) => c.repeat(64);
const genesis = (): FakeChain => ({ tip: 1000, hashes: { 1000: "0".repeat(60) + "1000" }, notes: [], defaultAddress: ADDR });

async function monitorHarness(chain = genesis(), extra: Partial<PaymentsConfig> = {}, fetcher?: Parameters<typeof startHarness>[1]) {
  const w = fakeWatcher(chain);
  const h = await startHarness(
    {
      mode: "monitor",
      demoMerchant: null,
      now: realNow,
      monitor: { authorized: true, source: w.scanner, minimumConfirmations: 20, intervalSeconds: 3600 },
      ...extra,
    },
    fetcher,
  );
  return { h, w };
}

const PAY = { amountUsd: "1.00" }; // 0.02 ZEC = 2,000,000 zat at the fixed demo rate

async function pay(h: Harness, key: string, body = PAY) {
  return h.call("/api/v1/payments", { key, body });
}

test("monitor mode requires authorization, a 20+ confirmation policy and no demo storefront", () => {
  const dir = mkdtempSync(join(tmpdir(), "zecone-mon-"));
  const base = {
    dbPath: join(dir, "p.sqlite"),
    checkoutAddress: ADDR,
    mode: "monitor" as const,
    siwe: { allowedDomains: [], ttlSeconds: 60 },
    publicCheckoutBaseUrl: "http://localhost:3000",
    exclusiveAllocation: true,
    quoteTtlSeconds: 900,
    maxAmountUsd: "10.00",
    relayerAvailableWei: 10n ** 17n,
    demoObserver: { enabled: false, startAfterSeconds: 1, stepSeconds: 1 },
    allowLoopbackHttpWebhooks: true,
    sessionTtlSeconds: 60,
  };
  const src = fakeWatcher(genesis()).scanner;
  try {
    assert.throws(() => createPaymentsApp({ ...base }), /MONITOR_NOT_AUTHORIZED/);
    assert.throws(() => createPaymentsApp({ ...base, monitor: { authorized: false, source: src, minimumConfirmations: 20, intervalSeconds: 60 } }), /MONITOR_NOT_AUTHORIZED/);
    assert.throws(() => createPaymentsApp({ ...base, monitor: { authorized: true, source: src, minimumConfirmations: 5, intervalSeconds: 60 } }), /CONFIRMATIONS_TOO_LOW/);
    assert.throws(
      () =>
        createPaymentsApp({
          ...base,
          demoMerchant: { secret: "x", payoutAddress: "0x4b5750d7675f14eB844B74477015302Bf31AE2dB" },
          monitor: { authorized: true, source: src, minimumConfirmations: 20, intervalSeconds: 60 },
        }),
      /DEMO_MERCHANT_FORBIDDEN/,
    );
    assert.throws(() => createPaymentsApp({ ...base, mode: "live" }), /LIVE_MODE_DISABLED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("monitor: real checkout needs a fresh watcher snapshot, then attributes, confirms and stops before payout", async () => {
  const delivered: { body: string; sig: string }[] = [];
  const { h, w } = await monitorHarness(genesis(), {}, async (_url, init) => {
    delivered.push({ body: String(init.body), sig: (init.headers as Record<string, string>)["X-ZecOne-Signature"] });
    return { ok: true, status: 200 };
  });
  try {
    const m = await onboard(h);
    // No snapshot yet: real checkouts are paused.
    const early = await pay(h, m.apiKey);
    assert.equal(early.status, 503);
    assert.equal(early.body.error.code, "watcher_not_ready");
    // A pre-existing note at our address (mined before any checkout).
    w.update((c) => c.notes.push({ txid: tx("1"), height: 990, zatoshis: "2000000", address: ADDR }));
    assert.deepEqual((await h.app.bridge!.tick()).ok, true);
    const hook = await h.call("/api/v1/webhooks", { key: m.apiKey, body: { url: "http://127.0.0.1:9/hook" } });
    const p = (await pay(h, m.apiKey)).body.payment;
    assert.equal(p.mode, "monitor");
    assert.equal(p.simulated, false);
    assert.equal(p.settlement, "disabled");
    assert.equal(p.zcashAddress, ADDR);
    assert.match(p.paymentUri, /^zcash:u1/);
    // Single active checkout on the shared address.
    const busy = await pay(h, m.apiKey);
    assert.equal(busy.body.error.code, "checkout_busy");
    // Old notes are never attributed to the new checkout, even with the exact amount:
    // one seen before the checkout existed, and one mined at the allocation tip but only
    // discovered by a later scan (watcher lag).
    w.update((c) => c.notes.push({ txid: tx("8"), height: 1000, zatoshis: "2000000", address: ADDR }));
    await h.app.bridge!.tick();
    assert.equal((await h.call(`/api/v1/payments/${p.id}`, { key: m.apiKey })).body.payment.state, "AWAITING_PAYMENT");
    const reasons = h.app.store.listUnattributed().map((d) => d.reason).sort();
    assert.deepEqual(reasons, ["no_active_checkout", "note_predates_checkout"]);
    // A new note in the next block.
    w.mine(1);
    w.update((c) => c.notes.push({ txid: tx("2"), height: 1001, zatoshis: "2000000", address: ADDR }));
    assert.equal((await h.app.bridge!.tick()).ok, true);
    let cur = (await h.call(`/api/v1/payments/${p.id}`, { key: m.apiKey })).body.payment;
    assert.equal(cur.state, "VERIFYING");
    assert.equal(cur.evidenceKind, "mainnet-observed");
    assert.equal(cur.detectedTxid, tx("2"));
    assert.equal(cur.chainEvidence.confirmations, 1);
    // Public checkout shows progress with confirmations, still no completion.
    const view = (await h.call(`/api/v1/checkout/${p.id}?token=${p.checkoutToken}`, { key: null })).body.checkout;
    assert.equal(view.paymentDetected, true);
    assert.equal(view.confirmations, 1);
    assert.equal(view.minimumConfirmations, 20);
    // 18 more blocks: 19 confirmations, not yet confirmed.
    w.mine(18);
    await h.app.bridge!.tick();
    assert.equal((await h.call(`/api/v1/payments/${p.id}`, { key: m.apiKey })).body.payment.state, "VERIFYING");
    // 20th confirmation.
    w.mine(1);
    await h.app.bridge!.tick();
    cur = (await h.call(`/api/v1/payments/${p.id}`, { key: m.apiKey })).body.payment;
    assert.equal(cur.state, "ZEC_CONFIRMED");
    assert.equal(cur.confirmations, 20);
    assert.match(cur.chainEvidence.paymentDigest, /^[0-9a-f]{64}$/);
    assert.equal(cur.chainEvidence.tip, 1020);
    assert.deepEqual(cur.chainEvidence.sources, ["https://light.example.org", "https://peer.example.org"]);
    // More blocks never trigger a payout in monitor mode.
    w.mine(30);
    await h.app.bridge!.tick();
    await h.app.tick();
    cur = (await h.call(`/api/v1/payments/${p.id}`, { key: m.apiKey })).body.payment;
    assert.equal(cur.state, "ZEC_CONFIRMED");
    assert.equal(cur.payoutTxHash, null);
    assert.equal((await h.call(`/api/v1/payments/${p.id}/receipt`, { key: m.apiKey })).body.error.code, "not_completed");
    const events = (await h.call(`/api/v1/payments/${p.id}/events`, { key: m.apiKey })).body.events;
    const confirmed = events.find((e: { type: string }) => e.type === "payment.zec_confirmed");
    assert.equal(confirmed.data.settlement, "disabled");
    assert.equal(confirmed.data.evidence, "mainnet-observed");
    // Signed webhook for the confirmation was delivered.
    await h.app.dispatcher.drain(realNow());
    const wh = delivered.find((d) => JSON.parse(d.body).type === "payment.zec_confirmed");
    assert.ok(wh);
    assert.ok(verifySignature(hook.body.webhook.secret, wh!.body, wh!.sig));
    // Address released: a second checkout can start.
    assert.equal((await pay(h, m.apiKey)).status, 201);
    // Health exposes the watcher state, payouts stay off.
    const health = (await h.call("/api/v1/health", { key: null })).body;
    assert.equal(health.mode, "monitor");
    assert.equal(health.livePayoutEnabled, false);
    assert.equal(health.watcher.tip, 1050);
  } finally {
    await h.close();
  }
});

test("monitor: amount mismatch goes to manual review; a txid can never fund two checkouts", async () => {
  const { h, w } = await monitorHarness();
  try {
    const m = await onboard(h);
    await h.app.bridge!.tick();
    const p1 = (await pay(h, m.apiKey)).body.payment;
    w.mine(1);
    w.update((c) => c.notes.push({ txid: tx("3"), height: 1001, zatoshis: "1999999", address: ADDR }));
    await h.app.bridge!.tick();
    assert.equal((await h.call(`/api/v1/payments/${p1.id}`, { key: m.apiKey })).body.payment.state, "MANUAL_REVIEW");
    // Allocation released by manual review; next checkout.
    const p2 = (await pay(h, m.apiKey)).body.payment;
    // A second output of the SAME transaction arrives later: never attributed to p2.
    w.mine(1);
    w.update((c) => c.notes.push({ txid: tx("3"), index: 1, height: 1002, zatoshis: "2000000", address: ADDR }));
    await h.app.bridge!.tick();
    assert.equal((await h.call(`/api/v1/payments/${p2.id}`, { key: m.apiKey })).body.payment.state, "AWAITING_PAYMENT");
    // Repeated ticks are idempotent.
    await h.app.bridge!.tick();
    await h.app.bridge!.tick();
    const notes = h.app.store.db.prepare(`SELECT status, COUNT(*) n FROM watch_notes GROUP BY status`).all() as { status: string; n: number }[];
    assert.deepEqual(Object.fromEntries(notes.map((r) => [r.status, Number(r.n)])), { attributed: 1, duplicate: 1 });
  } finally {
    await h.close();
  }
});

test("monitor: reorganization removing an attributed note sends the payment to manual review", async () => {
  const { h, w } = await monitorHarness();
  try {
    const m = await onboard(h);
    await h.app.bridge!.tick();
    const p = (await pay(h, m.apiKey)).body.payment;
    w.mine(2);
    w.update((c) => c.notes.push({ txid: tx("4"), height: 1002, zatoshis: "2000000", address: ADDR }));
    await h.app.bridge!.tick();
    assert.equal((await h.call(`/api/v1/payments/${p.id}`, { key: m.apiKey })).body.payment.state, "VERIFYING");
    // Reorg: block 1002 replaced, the note disappears, and the old tip hash changes.
    w.update((c) => {
      c.notes = c.notes.filter((n) => n.txid !== tx("4"));
      c.hashes[1001] = "c".repeat(64);
      c.hashes[1002] = "d".repeat(64);
      c.tip = 1003;
      c.hashes[1003] = "e".repeat(64);
    });
    const r = await h.app.bridge!.tick();
    assert.equal(r.ok, true);
    assert.equal(r.reorg, true);
    const cur = (await h.call(`/api/v1/payments/${p.id}`, { key: m.apiKey })).body.payment;
    assert.equal(cur.state, "MANUAL_REVIEW");
    const last = (await h.call(`/api/v1/payments/${p.id}/events`, { key: m.apiKey })).body.events.at(-1);
    assert.equal(last.data.reason, "chain_reorganization");
    assert.equal(h.app.bridge!.health().reorgsDetected, 1);
  } finally {
    await h.close();
  }
});

test("monitor: provider/scan failure fails closed and reports health; checkouts pause", async () => {
  const { h, w } = await monitorHarness();
  try {
    const m = await onboard(h);
    await h.app.bridge!.tick();
    const p = (await pay(h, m.apiKey)).body.payment;
    w.update((c) => (c.fail = "provider_disagreement"));
    const r = await h.app.bridge!.tick();
    assert.equal(r.ok, false);
    assert.equal(r.error, "mainnet_watch_scan_failed");
    assert.equal(h.app.bridge!.health().ready, false);
    assert.equal((await h.call(`/api/v1/payments/${p.id}`, { key: m.apiKey })).body.payment.state, "AWAITING_PAYMENT");
    await h.call(`/api/v1/payments/${p.id}/cancel`, { key: m.apiKey, body: {} });
    assert.equal((await pay(h, m.apiKey)).body.error.code, "watcher_not_ready");
    // Recovery.
    w.update((c) => delete c.fail);
    assert.equal((await h.app.bridge!.tick()).ok, true);
    assert.equal((await pay(h, m.apiKey)).status, 201);
  } finally {
    await h.close();
  }
});

test("monitor: restart resumes from the durable checkpoint without double-processing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zecone-restart-"));
  const db = join(dir, "p.sqlite");
  const w = fakeWatcher(genesis());
  const cfg = (): PaymentsConfig => ({
    dbPath: db,
    checkoutAddress: ADDR,
    mode: "monitor",
    siwe: { allowedDomains: ["127.0.0.1:4333"], ttlSeconds: 600 },
    publicCheckoutBaseUrl: "http://localhost:3000",
    exclusiveAllocation: true,
    quoteTtlSeconds: 900,
    maxAmountUsd: "10.00",
    relayerAvailableWei: 10n ** 17n,
    demoObserver: { enabled: false, startAfterSeconds: 1, stepSeconds: 1 },
    allowLoopbackHttpWebhooks: true,
    sessionTtlSeconds: 600,
    monitor: { authorized: true, source: w.scanner, minimumConfirmations: 20, intervalSeconds: 3600 },
  });
  try {
    let app = createPaymentsApp(cfg());
    const m = app.store.createMerchant({ name: "r", secret: "s", scopes: ["payments:create"], baseRecipient: "0x4b5750d7675f14eB844B74477015302Bf31AE2dB" });
    await app.bridge!.tick();
    const server = createServer((q, r) => void app.handle(q, r));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const created = await fetch(`http://127.0.0.1:${port}/api/v1/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${m.keyId}_s`, "Content-Type": "application/json" },
      body: JSON.stringify(PAY),
    }).then((r) => r.json());
    await new Promise<void>((r) => server.close(() => r()));
    w.mine(1);
    w.update((c) => c.notes.push({ txid: tx("5"), height: 1001, zatoshis: "2000000", address: ADDR }));
    await app.bridge!.tick();
    const eventsBefore = app.store.listEvents(created.payment.id).length;
    app.close();
    // Restart: new process state, same database.
    app = createPaymentsApp(cfg());
    await app.bridge!.tick();
    await app.bridge!.tick();
    assert.equal(app.store.listEvents(created.payment.id).length, eventsBefore);
    assert.equal(app.store.getPayment(created.payment.id)!.state, "VERIFYING");
    w.mine(19);
    await app.bridge!.tick();
    assert.equal(app.store.getPayment(created.payment.id)!.state, "ZEC_CONFIRMED");
    app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("demo and monitor stay isolated: no payable address in demo; replay and real evidence never mix", async () => {
  const h = await startHarness();
  try {
    const p = (await h.call("/api/v1/payments", { body: PAY })).body.payment;
    assert.equal(p.simulated, true);
    assert.equal(p.zcashAddress, null);
    assert.equal(p.paymentUri, null);
    const view = (await h.call(`/api/v1/checkout/${p.id}?token=${p.checkoutToken}`, { key: null })).body.checkout;
    assert.equal(view.simulated, true);
    assert.equal(view.zcashAddress, null);
    assert.equal(view.paymentUri, null);
    // Demo payments never hold the real address, so concurrent demo checkouts are fine.
    assert.equal((await h.call("/api/v1/payments", { body: PAY })).status, 201);
    // Real-chain evidence cannot attach to a demo payment.
    assert.throws(() => h.app.store.markDetected(p.id, tx("6"), "2000000", realNow(), "mainnet-observed"), /real chain evidence/);
  } finally {
    await h.close();
  }
  const dir = mkdtempSync(join(tmpdir(), "zecone-iso-"));
  const store = new PaymentStore(join(dir, "p.sqlite"));
  try {
    const m = store.createMerchant({ name: "x", secret: "s", scopes: [], baseRecipient: "0x4b5750d7675f14eB844B74477015302Bf31AE2dB" });
    const { payment } = store.createPayment({ merchantId: m.id, request: { amountUsd: "1.00", payoutChain: "base", recipient: "0x4b5750d7675f14eB844B74477015302Bf31AE2dB" }, mode: "monitor" });
    // The demo replay refuses non-demo payments, and replayed evidence cannot attach to them.
    assert.equal(replayStep(store, payment.id), null);
    assert.throws(() => store.markDetected(payment.id, tx("7"), "1", realNow(), "recorded-mainnet-replay"), /replayed evidence/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public checkout SSE streams state changes", async () => {
  const h = await startHarness({ now: realNow, demoObserver: { enabled: true, startAfterSeconds: 0, stepSeconds: 0 } });
  try {
    const p = (await h.call("/api/v1/payments", { body: PAY })).body.payment;
    const res = await fetch(`${h.base}/api/v1/checkout/${p.id}/events?token=${p.checkoutToken}`);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const states: string[] = [];
    let buf = "";
    const done = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += Buffer.from(value).toString();
        for (const m of buf.matchAll(/event: checkout\ndata: (.*)\n\n/g)) states.push(JSON.parse(m[1]).state);
        buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
      }
    })();
    for (let i = 0; i < 10; i++) {
      await h.app.tick();
      await new Promise((r) => setTimeout(r, 1100));
      if (states.at(-1) === "COMPLETED") break;
    }
    await done;
    assert.equal(states[0], "AWAITING_PAYMENT");
    assert.equal(states.at(-1), "COMPLETED");
    const bad = await fetch(`${h.base}/api/v1/checkout/${p.id}/events?token=${"0".repeat(40)}`);
    assert.equal(bad.status, 404);
  } finally {
    await h.close();
  }
});

test("monitor: simultaneous checkouts on the shared address — exactly one wins", async () => {
  const { h } = await monitorHarness();
  try {
    const a = await onboard(h);
    const b = await onboard(h);
    await h.app.bridge!.tick();
    const race = await Promise.all([pay(h, a.apiKey), pay(h, b.apiKey), pay(h, a.apiKey, { amountUsd: "2.00" }), pay(h, b.apiKey)]);
    assert.equal(race.filter((r) => r.status === 201).length, 1);
    assert.equal(race.filter((r) => r.body.error?.code === "checkout_busy").length, 3);
  } finally {
    await h.close();
  }
});

test("payment API source imports no signing, submission, broadcast or spending code", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const forbidden = /(mainnet-signer|mainnet-submitter|mainnet-executor|mainnet-transfer|signer\/|keystore|wallet-vault|zcash-mainnet-spend|offline-sign|broadcast)/;
  for (const f of readdirSync("services/payments")) {
    const src = readFileSync(join("services/payments", f), "utf8");
    for (const m of src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)) assert.doesNotMatch(m[1], forbidden, `${f} imports ${m[1]}`);
  }
});

test("monitor: quotes beyond the relayer liquidity snapshot are refused; demo quotes promise no payout", async () => {
  const { h } = await monitorHarness(genesis(), { relayerAvailableWei: 10_000_000_000_000n });
  try {
    const m = await onboard(h);
    await h.app.bridge!.tick();
    const r = await pay(h, m.apiKey);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "insufficient_liquidity");
    assert.equal((await h.call("/api/v1/payments", { key: m.apiKey })).body.payments.length, 0);
  } finally {
    await h.close();
  }
  const d = await startHarness({ relayerAvailableWei: 0n });
  try {
    assert.equal((await d.call("/api/v1/payments", { body: { amountUsd: "20.00" } })).status, 201);
  } finally {
    await d.close();
  }
});
