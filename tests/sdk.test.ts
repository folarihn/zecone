// @zecone/sdk against a real in-process ZecOne API: server client, safe retries,
// receipts, webhook verification, browser guard and the browser-safe checkout
// helpers. Synthetic only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onboard, startHarness } from "./helpers/payments-harness.ts";
import { ZecOne, ZecOneError, constructEvent } from "../sdk/src/index.ts";
import { signWebhook } from "../sdk/src/webhooks.ts";
import { fetchCheckout, phaseOf, qrSvg, stepIndex, watchCheckout } from "../sdk/src/checkout.ts";

test("sdk: create, retrieve, list, quote, events, cancel and receipt", async () => {
  const h = await startHarness();
  try {
    const { apiKey } = await onboard(h);
    const z = new ZecOne({ apiKey, baseUrl: h.base });
    const p = await z.payments.create({ amountUsd: "1.00", metadata: { orderId: "o-1" }, description: "Access pass" });
    assert.equal(p.state, "AWAITING_PAYMENT");
    assert.equal(p.quote?.zecAmount, "0.02");
    assert.ok(p.checkoutUrl.includes(p.id));
    assert.equal((await z.payments.retrieve(p.id)).id, p.id);
    assert.equal((await z.payments.list()).length, 1);
    assert.equal((await z.payments.quote(p.id)).zecAmountZat, "2000000");
    assert.ok((await z.payments.events(p.id)).some((e) => e.type === "payment.awaiting_payment"));
    await assert.rejects(z.payments.receipt(p.id), (e: ZecOneError) => e.code === "not_completed" && e.status === 409);
    const canceled = await z.payments.cancel(p.id);
    assert.equal(canceled.state, "EXPIRED");
    const p2 = await z.payments.create({ amountUsd: "1.00" });
    for (let i = 0; i < 12; i++) {
      h.clock.now += 10;
      await h.app.tick();
    }
    const done = await z.payments.waitForTerminal(p2.id, { timeoutMs: 2000, intervalMs: 50 });
    assert.equal(done.state, "COMPLETED");
    const receipt = await z.payments.receipt(p2.id);
    assert.equal(receipt.evidenceKind, "recorded-mainnet-replay");
    assert.match(receipt.payout.explorerUrl!, /^https:\/\/basescan\.org\/tx\/0x/);
    // Typed errors.
    await assert.rejects(z.payments.create({ amountUsd: "1.234" }), (e: ZecOneError) => e.code === "invalid_amount");
    await assert.rejects(z.payments.retrieve("pay_nope"), (e: ZecOneError) => e.code === "invalid_id");
    const bad = new ZecOne({ apiKey: "zk_" + "1".repeat(24) + "_wrong", baseUrl: h.base, maxRetries: 0 });
    await assert.rejects(bad.payments.list(), (e: ZecOneError) => e.status === 401 && e.code === "unauthorized");
  } finally {
    await h.close();
  }
});

test("sdk: a lost response is retried with the same idempotency key (no duplicate order)", async () => {
  const h = await startHarness();
  try {
    let calls = 0;
    const flaky = async (url: string, init?: RequestInit) => {
      const res = await fetch(url, init);
      calls++;
      if (calls === 1 && init?.method === "POST") throw new TypeError("socket hang up"); // server processed, client lost it
      return res;
    };
    const z = new ZecOne({ apiKey: h.app.demoApiKey!, baseUrl: h.base, fetch: flaky });
    const p = await z.payments.create({ amountUsd: "1.00" });
    assert.equal(calls, 2);
    const all = await z.payments.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, p.id);
  } finally {
    await h.close();
  }
});

test("sdk: webhook constructEvent verifies raw bodies and rejects tampering/replay", () => {
  const secret = "whsec_" + "ab".repeat(24);
  const body = JSON.stringify({ id: "evt_1", type: "payment.completed", event: "payment.completed", created: 1, livemode: false, attempt: 1, payment: { id: "pay_x" } });
  const now = 1_900_000_000;
  const sig = signWebhook(secret, body, now);
  const ev = constructEvent(body, sig, secret, { now });
  assert.equal(ev.type, "payment.completed");
  assert.throws(() => constructEvent(body.replace("completed", "failed"), sig, secret, { now }), /verification failed/);
  assert.throws(() => constructEvent(body, sig, secret, { now: now + 301 }), /verification failed/);
  assert.throws(() => constructEvent(body, null, secret, { now }), /verification failed/);
  assert.throws(() => constructEvent(body, sig, "whsec_other", { now }), /verification failed/);
});

test("sdk: the secret-key client refuses to run in a browser", () => {
  const g = globalThis as Record<string, unknown>;
  g.window = {};
  g.document = {};
  try {
    assert.throws(() => new ZecOne({ apiKey: "zk_x_y" }), (e: ZecOneError) => e.code === "browser_forbidden");
  } finally {
    delete g.window;
    delete g.document;
  }
});

test("sdk/checkout: browser-safe status polling, QR and step mapping", async () => {
  const h = await startHarness();
  try {
    const z = new ZecOne({ apiKey: h.app.demoApiKey!, baseUrl: h.base });
    const p = await z.payments.create({ amountUsd: "1.00" });
    const view = await fetchCheckout(h.base, p.id, p.checkoutToken);
    assert.equal(view.state, "AWAITING_PAYMENT");
    assert.equal(phaseOf(view.state), "awaiting");
    await assert.rejects(fetchCheckout(h.base, p.id, "f".repeat(40)), (e: ZecOneError) => e.status === 404);
    assert.equal(view.paymentUri, null); // simulated checkout: nothing payable
    const qr = qrSvg(p.checkoutUrl);
    assert.ok(qr.size > 40 && qr.path.startsWith("M"));
    assert.equal(stepIndex("PAYOUT_SUBMITTED"), 3);
    const seen: string[] = [];
    let firstSeen!: () => void;
    const first = new Promise<void>((r) => (firstSeen = r));
    let driver: Promise<void> = Promise.resolve();
    await new Promise<void>((resolve) => {
      const stop = watchCheckout(h.base, p.id, p.checkoutToken, {
        intervalMs: 20,
        onUpdate: (c) => {
          seen.push(c.state);
          if (seen.length === 1) firstSeen();
          if (c.state === "COMPLETED") {
            stop();
            resolve();
          }
        },
      });
      driver = (async () => {
        await first;
        for (let i = 0; i < 12; i++) {
          h.clock.now += 10;
          await h.app.tick();
          await new Promise((r) => setTimeout(r, 40));
        }
      })();
    });
    await driver;
    assert.equal(seen[0], "AWAITING_PAYMENT");
    assert.equal(seen.at(-1), "COMPLETED");
    assert.ok(seen.length >= 3);
  } finally {
    await h.close();
  }
});
