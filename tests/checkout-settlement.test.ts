// Checkout order ↔ operator payout session bookkeeping. Synthetic store and
// journal only: no network, no keys, no signing or broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PaymentStore } from "../services/payments/store.ts";
import { DemoQuoteEngine } from "../services/payments/quote.ts";
import { DEFAULT_CHECKOUT_ADDRESS } from "../services/payments/api.ts";
import {
  assertCheckoutPricedPayout,
  checkoutOrderId,
  checkoutPayoutPolicy,
  checkoutPricingArgs,
  checkoutSettlementBinding,
  recordCheckoutPayout,
} from "../services/payments/checkout-settlement.ts";

const RECIPIENT = "0x4b5750d7675f14eB844B74477015302Bf31AE2dB";
const ACCOUNT = "a".repeat(64);
const PAYMENT_DIGEST = "d".repeat(64);
const OWNERSHIP = "e".repeat(64);
const TXID = "f".repeat(64);
const BASE_TX = "0x" + "1".repeat(64);
const T0 = 1_800_000_000;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function confirmedOrder(mode: "monitor" | "demo" = "monitor", recipient = RECIPIENT) {
  const dir = mkdtempSync(join(tmpdir(), "checkout-settlement-"));
  const store = new PaymentStore(join(dir, "payments.sqlite"));
  const m = store.createMerchant({ name: "Pilot", secret: "s".repeat(40), scopes: ["payments:create"], baseRecipient: recipient, now: T0 });
  const { payment } = store.createPayment({ merchantId: m.id, request: { amountUsd: "1.00", payoutChain: "base", recipient }, mode, now: T0 });
  const quote = new DemoQuoteEngine(900).quote({ amountUsd: "1.00", payoutChain: "base", now: T0 });
  const real = mode === "monitor";
  store.setQuote(payment.id, quote, real ? DEFAULT_CHECKOUT_ADDRESS : null, quote.expiresAt, T0, {
    exclusive: true,
    allocationTip: real ? 100 : null,
    window: real ? { paymentDeadline: quote.expiresAt, observationDeadline: quote.expiresAt + 2700, paymentExpiryHeight: 110 } : null,
  });
  const zat = quote.zecAmountZat;
  if (mode === "monitor") {
    store.markDetected(payment.id, TXID, zat, T0 + 60, "mainnet-observed");
    // The integrated pilot wallet signed and broadcast this exact txid before the deadline.
    store.setWalletEvidence(payment.id, {
      version: 1, sessionId: "5".repeat(32), txid: TXID, signedDigest: "6".repeat(64), destination: DEFAULT_CHECKOUT_ADDRESS,
      zatoshis: zat, expiryHeight: 110, approvalExpires: quote.expiresAt, signApprovedAt: T0 + 10, signedAt: T0 + 11,
      broadcastApprovedAt: T0 + 12, broadcastAttemptAt: T0 + 13,
    }, T0 + 60);
    store.setChainEvidence(payment.id, {
      noteKey: `${TXID}:3:0`, txid: TXID, pool: 3, height: 101, blockHash: "b".repeat(64), zatoshis: zat,
      confirmations: 20, minimumConfirmations: 20, tip: 120, tipHash: "c".repeat(64), ownershipDigest: OWNERSHIP,
      paymentDigest: PAYMENT_DIGEST, sources: ["zec.rocks", "stardust"], observedAt: T0 + 1500,
    }, T0 + 1500);
    assert.ok(store.transition(payment.id, "ZEC_CONFIRMED", {}, T0 + 1500));
  }
  return { dir, store, id: payment.id, zat, payoutWei: quote.ethPayoutWei };
}

function journal(dir: string, orderId: string, terms: unknown, state: string, sourceCommitment = PAYMENT_DIGEST) {
  const path = join(dir, "submissions.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS mainnet_submissions(order_id TEXT PRIMARY KEY, network TEXT, source_commitment TEXT, transaction_id TEXT, broadcast_txid TEXT, state TEXT, finalized_ref TEXT, terms_binding TEXT)");
  db.prepare("INSERT OR REPLACE INTO mainnet_submissions VALUES(?,?,?,?,?,?,?,?)").run(orderId, "base", sourceCommitment, BASE_TX, state === "broadcast" || state === "finalized" ? BASE_TX : null, state, state === "finalized" ? "53100000" : null, digest(terms));
  db.close();
  return path;
}

const termsFor = (zat: string, payoutWei: string, recipient = RECIPIENT) => ({
  version: 1, network: "base", recipient, amount: payoutWei, sourceZatoshis: zat, sourcePaymentCommitment: PAYMENT_DIGEST, expires: T0 + 4000,
});

test("binds only a watcher-confirmed order to the allow-listed recipient", () => {
  const { dir, store, id, zat } = confirmedOrder();
  try {
    const b = checkoutSettlementBinding(store, id, { account: ACCOUNT, allowedRecipient: RECIPIENT, windowSeconds: 3600, now: T0 + 1600 });
    assert.equal(b.watchBinding.orderId, checkoutOrderId(id));
    assert.equal(b.watchBinding.address, DEFAULT_CHECKOUT_ADDRESS);
    assert.equal(b.sourceCommitment, PAYMENT_DIGEST);
    assert.equal(b.sourceEvidenceDigest, OWNERSHIP);
    assert.equal(b.sourceZatoshis, zat);
    assert.match(b.quotedPayoutWei, /^[1-9][0-9]+$/);
    assert.equal(b.watchBinding.expires, T0 + 1600 + 3600);
    // The exact attributed output and the order's window are bound immutably.
    assert.deepEqual(b.watchBinding.payment, { txid: TXID, pool: 3, index: 0, height: 101, windowStart: 100, windowEnd: 110 });
    assert.throws(
      () => checkoutSettlementBinding(store, id, { account: ACCOUNT, allowedRecipient: "0x000000000000000000000000000000000000dEaD", windowSeconds: 3600, now: T0 }),
      /CHECKOUT_RECIPIENT_NOT_ALLOWLISTED/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a payment outside the order window or with a mismatched note key", () => {
  // A payment mined after the window also outlives the wallet's expiry height.
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ height: 100 }, /CHECKOUT_PAYMENT_OUTSIDE_ORDER_WINDOW/],
    [{ height: 111 }, /CHECKOUT_PAYMENT_OUTSIDE_ORDER_WINDOW|CHECKOUT_WALLET_EVIDENCE_REQUIRED/],
    [{ noteKey: `${TXID}:2:0` }, /CHECKOUT_PAYMENT_OUTSIDE_ORDER_WINDOW/],
    [{ noteKey: `${"0".repeat(64)}:3:0` }, /CHECKOUT_PAYMENT_OUTSIDE_ORDER_WINDOW/],
  ];
  for (const [change, expected] of cases) {
    const o = confirmedOrder();
    try {
      o.store.setChainEvidence(o.id, { ...o.store.getPayment(o.id)!.chainEvidence!, ...change }, T0 + 1500);
      assert.throws(
        () => checkoutSettlementBinding(o.store, o.id, { account: ACCOUNT, allowedRecipient: RECIPIENT, windowSeconds: 3600, now: T0 + 1600 }),
        expected,
        JSON.stringify(change),
      );
    } finally {
      o.store.close();
      rmSync(o.dir, { recursive: true, force: true });
    }
  }
});

test("refuses demo, unconfirmed and digest-less orders", () => {
  const demo = confirmedOrder("demo");
  try {
    assert.throws(() => checkoutSettlementBinding(demo.store, demo.id, { account: ACCOUNT, allowedRecipient: RECIPIENT, windowSeconds: 3600, now: T0 }), /CHECKOUT_NOT_REAL_MAINNET_ORDER/);
  } finally {
    demo.store.close();
    rmSync(demo.dir, { recursive: true, force: true });
  }
  const o = confirmedOrder();
  try {
    o.store.transition(o.id, "MANUAL_REVIEW", {}, T0 + 1700);
    assert.throws(() => checkoutSettlementBinding(o.store, o.id, { account: ACCOUNT, allowedRecipient: RECIPIENT, windowSeconds: 3600, now: T0 }), /CHECKOUT_NOT_ZEC_CONFIRMED/);
  } finally {
    o.store.close();
    rmSync(o.dir, { recursive: true, force: true });
  }
});

test("records the journal outcome idempotently and only when everything matches", () => {
  const { dir, store, id, zat, payoutWei } = confirmedOrder();
  try {
    const terms = termsFor(zat, payoutWei);
    const missing = join(dir, "empty.sqlite");
    const empty = new DatabaseSync(missing);
    empty.exec("CREATE TABLE mainnet_submissions(order_id TEXT PRIMARY KEY)");
    empty.close();
    assert.equal(recordCheckoutPayout(store, id, missing, terms, T0 + 2000).status, "not_submitted");

    // A journal row for a different source commitment is refused.
    const wrong = journal(join(dir), checkoutOrderId(id), terms, "broadcast", "0".repeat(64));
    assert.throws(() => recordCheckoutPayout(store, id, wrong, terms, T0 + 2000), /PAYOUT_JOURNAL_DOES_NOT_MATCH_ORDER/);
    // Tampered plan terms (different recipient) are refused.
    journal(dir, checkoutOrderId(id), terms, "broadcast");
    const path = join(dir, "submissions.sqlite");
    assert.throws(() => recordCheckoutPayout(store, id, path, { ...terms, amount: "200000000000000" }, T0 + 2000), /PAYOUT_JOURNAL_DOES_NOT_MATCH_ORDER/);
    const repriced = { ...terms, amount: (BigInt(terms.amount) + 1n).toString() };
    journal(dir, checkoutOrderId(id), repriced, "broadcast");
    assert.throws(() => recordCheckoutPayout(store, id, path, repriced, T0 + 2000), /PAYOUT_JOURNAL_DOES_NOT_MATCH_ORDER/);
    journal(dir, checkoutOrderId(id), terms, "broadcast");
    assert.equal(store.getPayment(id)!.state, "ZEC_CONFIRMED");

    const db = new DatabaseSync(path);
    db.prepare("UPDATE mainnet_submissions SET broadcast_txid=? WHERE order_id=?").run("0x" + "2".repeat(64), checkoutOrderId(id));
    db.close();
    assert.throws(() => recordCheckoutPayout(store, id, path, terms, T0 + 2000), /PAYOUT_JOURNAL_BROADCAST_TXID_MISMATCH/);
    journal(dir, checkoutOrderId(id), terms, "broadcast");

    const submitted = recordCheckoutPayout(store, id, path, terms, T0 + 2000);
    assert.deepEqual(submitted, { status: "submitted", state: "PAYOUT_SUBMITTED", txHash: BASE_TX, wei: terms.amount });
    assert.equal(recordCheckoutPayout(store, id, path, terms, T0 + 2001).status, "submitted");

    journal(dir, checkoutOrderId(id), terms, "finalized");
    const done = recordCheckoutPayout(store, id, path, terms, T0 + 2100);
    assert.equal(done.status, "completed");
    const p = store.getPayment(id)!;
    assert.equal(p.state, "COMPLETED");
    assert.equal(p.payoutTxHash, BASE_TX);
    assert.equal(p.payoutWei, terms.amount);
    assert.deepEqual(
      store.listEvents(id).map((e) => e.state).slice(-4),
      ["PAYOUT_PENDING", "PAYOUT_SUBMITTED", "PAYOUT_CONFIRMED", "COMPLETED"],
    );
    assert.equal(recordCheckoutPayout(store, id, path, terms, T0 + 2200).status, "completed");
    assert.equal(store.listEvents(id).filter((e) => e.state === "COMPLETED").length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an uncertain submission requires reconciliation and changes nothing", () => {
  const { dir, store, id, zat, payoutWei } = confirmedOrder();
  try {
    const terms = termsFor(zat, payoutWei);
    const path = journal(dir, checkoutOrderId(id), terms, "uncertain");
    assert.equal(recordCheckoutPayout(store, id, path, terms, T0 + 2000).status, "reconcile_required");
    assert.equal(store.getPayment(id)!.state, "ZEC_CONFIRMED");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("payout policy: exact quote by default, repricing only on request and never above the quote", () => {
  assert.equal(checkoutPayoutPolicy(undefined), "quoted");
  assert.equal(checkoutPayoutPolicy("quoted"), "quoted");
  assert.equal(checkoutPayoutPolicy("reprice-at-current-price"), "reprice-at-current-price");
  assert.throws(() => checkoutPayoutPolicy("market"), /CHECKOUT_PAYOUT_POLICY_INVALID/);

  assert.deepEqual(checkoutPricingArgs("quoted", "1000", "810"), ["--amount", "1000"]);
  assert.deepEqual(checkoutPricingArgs("reprice-at-current-price", "1000", "810"), ["--source-zatoshis", "810"]);

  assert.equal(assertCheckoutPricedPayout("quoted", "1000", "1000"), "1000");
  assert.throws(() => assertCheckoutPricedPayout("quoted", "1000", "999"), /CHECKOUT_QUOTED_PAYOUT_CHANGED/);
  assert.equal(assertCheckoutPricedPayout("reprice-at-current-price", "1000", "987"), "987");
  assert.equal(assertCheckoutPricedPayout("reprice-at-current-price", "1000", "1000"), "1000");
  assert.throws(() => assertCheckoutPricedPayout("reprice-at-current-price", "1000", "1001"), /CHECKOUT_REPRICED_PAYOUT_EXCEEDS_QUOTE/);
  assert.throws(() => assertCheckoutPricedPayout("reprice-at-current-price", "1000", "0"), /CHECKOUT_QUOTED_PAYOUT_CHANGED/);
});

test("records a repriced payout below the quote and refuses one above it", () => {
  const { dir, store, id, zat, payoutWei } = confirmedOrder();
  try {
    const above = termsFor(zat, (BigInt(payoutWei) + 1n).toString());
    const path = journal(dir, checkoutOrderId(id), above, "broadcast");
    assert.throws(() => recordCheckoutPayout(store, id, path, above, T0 + 2000), /PAYOUT_JOURNAL_DOES_NOT_MATCH_ORDER/);
    const repriced = termsFor(zat, ((BigInt(payoutWei) * 986n) / 1000n).toString());
    journal(dir, checkoutOrderId(id), repriced, "broadcast");
    const r = recordCheckoutPayout(store, id, path, repriced, T0 + 2000);
    assert.deepEqual(r, { status: "submitted", state: "PAYOUT_SUBMITTED", txHash: BASE_TX, wei: repriced.amount });
    assert.equal(store.getPayment(id)!.payoutWei, repriced.amount);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the payout session prices checkout orders only through the policy helpers", () => {
  const src = readFileSync(new URL("../scripts/mainnet-pilot-session.ts", import.meta.url), "utf8");
  assert.match(src, /checkoutPricingArgs\(\s*payoutPolicy,/);
  assert.match(src, /assertCheckoutPricedPayout\(\s*payoutPolicy,/);
  assert.match(src, /if \(!checkoutScope && c\.checkoutPayoutPolicy !== undefined\)/);
  assert.doesNotMatch(src, /\["--amount", c\.quotedPayoutWei/);
});
