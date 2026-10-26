// Tests for the ZecOne payment domain: decimal-safe money, state machine,
// idempotency, webhook signatures, quote, and attribution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits, formatUnits, MoneyError } from "../services/payments/money.ts";
import { PaymentStore } from "../services/payments/store.ts";
import { DemoQuoteEngine } from "../services/payments/quote.ts";
import { signPayload, verifySignature } from "../services/payments/webhooks.ts";
import { verifyDetected } from "../services/payments/attribution.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "zecone-payments-"));
  return { dir, path: join(dir, "payments.sqlite") };
}

test("money: parse/format roundtrips exact with no floats", () => {
  assert.equal(formatUnits(parseUnits("0.00645937", "zec"), "zec"), "0.00645937");
  assert.equal(parseUnits("0.00645937", "zec"), 645937n); // zatoshis
  assert.equal(formatUnits(parseUnits("1.00", "usd"), "usd"), "1");
  assert.equal(parseUnits("1.00", "usd"), 100n); // cents
  assert.equal(formatUnits(3284955372432969n, "eth"), "0.003284955372432969");
});

test("money: rejects too many decimals and invalid input", () => {
  assert.throws(() => parseUnits("0.123456789", "zec"), MoneyError);
  assert.throws(() => parseUnits("1.234", "usd"), MoneyError);
  assert.throws(() => parseUnits("abc", "usd"), MoneyError);
  assert.throws(() => parseUnits("-1.00", "usd"), MoneyError);
  assert.throws(() => parseUnits("1e3", "usd"), MoneyError);
});

test("quote: demo quote is deterministic and exact", () => {
  const engine = new DemoQuoteEngine(900, { numerator: 50_00n, denominator: 1n, decimals: 2 }, {
    numerator: 3284955372432969n,
    denominator: 645_937n,
  });
  const q = engine.quote({ amountUsd: "1.00", payoutChain: "base", now: 1000 });
  assert.equal(q.amountUsd, "1.00");
  // 1.00 USD at $50/ZEC = 0.02 ZEC
  assert.equal(q.zecAmount, "0.02");
  assert.equal(q.zecAmountZat, "2000000");
  assert.equal(q.expiresAt, 1900);
  // 0.02 ZEC at the recorded rate -> wei (exact rational math, no floats)
  const expectedWei = ((2000000n * 3284955372432969n) / 645_937n).toString();
  assert.equal(q.ethPayoutWei, expectedWei);
});

test("store: state machine enforces valid transitions", () => {
  const { dir, path } = tempDb();
  const s = new PaymentStore(path);
  const m = s.createMerchant({ name: "t", secret: "secret", scopes: ["payments:create"] });
  const { payment } = s.createPayment({
    merchantId: m.id,
    request: { amountUsd: "1.00", payoutChain: "base", recipient: "0x4b5750d7675f14eB844B74477015302Bf31AE2dB" },
    mode: "demo",
  });
  // CREATED -> QUOTED ok, CREATED -> COMPLETED invalid
  assert.equal(s.transition(payment.id, "QUOTED"), true);
  assert.equal(s.transition(payment.id, "COMPLETED"), false);
  // QUOTED -> AWAITING_PAYMENT ok
  assert.equal(s.transition(payment.id, "AWAITING_PAYMENT"), true);
  assert.equal(s.getPayment(payment.id)!.state, "AWAITING_PAYMENT");
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("store: idempotency returns the same payment for the same key", () => {
  const { dir, path } = tempDb();
  const s = new PaymentStore(path);
  const m = s.createMerchant({ name: "t", secret: "secret", scopes: ["payments:create"] });
  const req = { amountUsd: "1.00", payoutChain: "base" as const, recipient: "0x4b5750d7675f14eB844B74477015302Bf31AE2dB" };
  const a = s.createPayment({ merchantId: m.id, request: req, mode: "demo", idempotencyKey: "order-1" });
  const b = s.createPayment({ merchantId: m.id, request: req, mode: "demo", idempotencyKey: "order-1" });
  assert.equal(a.payment.id, b.payment.id);
  assert.equal(b.created, false);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("store: merchant authentication rejects wrong keys", () => {
  const { dir, path } = tempDb();
  const s = new PaymentStore(path);
  const m = s.createMerchant({ name: "t", secret: "s3cret-value", scopes: ["payments:create"] });
  const fullKey = `${m.keyId}_s3cret-value`;
  assert.ok(s.authenticate(fullKey));
  assert.equal(s.authenticate(`${m.keyId}_wrong`), null);
  assert.equal(s.authenticate("garbage"), null);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("webhooks: signature verifies and rejects replay", () => {
  const secret = "whsec_abc";
  const payload = JSON.stringify({ event: "payment.completed", payment: { id: "x" } });
  const sig = signPayload(secret, payload, 1000);
  assert.ok(verifySignature(secret, payload, sig, { now: 1100 }));
  assert.ok(verifySignature(secret, payload, sig, { now: 1000 }));
  // stale timestamp (replay)
  assert.equal(verifySignature(secret, payload, sig, { now: 2000 }), false);
  // wrong secret
  assert.equal(verifySignature("whsec_other", payload, sig, { now: 1000 }), false);
});

test("attribution: exact amount only, under/over rejected", () => {
  assert.deepEqual(verifyDetected("645937", "645937"), { ok: true });
  assert.equal(verifyDetected("645937", "645936").ok, false);
  assert.equal(verifyDetected("645937", "645938").ok, false);
  assert.equal(verifyDetected("645937", "1").ok, false);
});
