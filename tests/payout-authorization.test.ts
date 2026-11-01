// Payout authorization on a shared checkout address: only the exact payment
// immutably bound to the order counts. Reproduces the real 804 + 810 case (an
// earlier, unrelated note at the same address) and every substitution, window,
// segment, reorganization and replay case. Synthetic chain only: the fake
// observe-mainnet enforces the raw-block rule; the journal, binding and
// authorization are the real ones. No network, keys, signing or broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeTargetedWatcher, blockBytes, blockHash } from "./helpers/fake-targeted-watcher.ts";
import { DEFAULT_CHECKOUT_ADDRESS } from "../services/payments/api.ts";
import {
  assertMainnetPaymentAuthorization,
  MainnetWatchJournal,
  observeMainnetWatch,
  pilotSessionWatchScanner,
  type MainnetOrderBinding,
  type MainnetWatchObservation,
} from "../services/settlement/mainnet-watch.ts";

const ADDR = DEFAULT_CHECKOUT_ADDRESS;
const TIP = 5000;
const N = 20;
const tx = (c: string) => c.repeat(64);
const ORDER = "4".repeat(64);

function sharedAddress() {
  const W0 = TIP + 30; // this order's window: (W0, W1]
  const W1 = W0 + 10;
  const OLD = TIP + 1; // the earlier, unrelated 804-zatoshi payment
  const PAY = W0 + 2; // this order's 810-zatoshi payment
  const EXPIRES = Math.floor(Date.now() / 1000) + 3600;
  const w = fakeTargetedWatcher({ tip: PAY + N + 5, hashes: {}, notes: [], defaultAddress: ADDR });
  w.update((c) => {
    c.notes.push({ txid: tx("8"), height: OLD, zatoshis: "804", address: ADDR, walletInternal: true });
    c.notes.push({ txid: tx("2"), height: PAY, zatoshis: "810", address: ADDR, walletInternal: true });
  });
  const seed = (from: number) => {
    for (let h = from; h < from + N; h++) writeFileSync(join(w.candidates, `${h}-${blockHash(w.chain, h)}.bin`), blockBytes(w.chain, h));
  };
  seed(OLD);
  seed(PAY);
  // The fake watcher's ownership digest for a note (see fake-targeted-watcher.ts).
  const ownership = (t: string) => createHash("sha256").update(t + "0").digest("hex");
  const binding = (
    over: Partial<MainnetOrderBinding> = {},
    payment: Partial<NonNullable<MainnetOrderBinding["payment"]>> = {},
  ): MainnetOrderBinding => ({
    orderId: ORDER,
    account: "a".repeat(64),
    address: ADDR,
    zatoshis: "810",
    expires: EXPIRES,
    sourceEvidenceDigest: ownership(tx("2")),
    payment: { txid: tx("2"), pool: 3, index: 0, height: PAY, windowStart: W0, windowEnd: W1, ...payment },
    ...over,
  });
  const scanner = pilotSessionWatchScanner(
    { watchWallet: w.wallet, watchBinary: process.execPath, authenticatedBlocks: w.corpus, candidateBlocks: w.candidates, receivingAddress: ADDR },
    w.policy,
    w.executableArgsPrefix,
  );
  return { w, W0, W1, OLD, PAY, binding, scanner, seed, ownership, close: () => rmSync(w.dir, { recursive: true, force: true }) };
}

const authorized = (r: MainnetWatchObservation, b: MainnetOrderBinding, now?: number) => {
  try {
    return assertMainnetPaymentAuthorization(r, { orderId: b.orderId, paymentDigest: r.paymentDigest ?? "", zatoshis: b.zatoshis }, now);
  } catch {
    return false;
  }
};

test("the exact 810 payment is authorized and the earlier 804 stays separate and untouched", async () => {
  const t = sharedAddress();
  try {
    const journal = new MainnetWatchJournal(":memory:");
    const b = t.binding();
    const r = await observeMainnetWatch(journal, t.scanner, b);
    assert.equal(r.status, "confirmed");
    assert.equal(r.receivedZatoshis, "810");
    assert.equal(authorized(r, b), true);
    // The 804 note is neither counted nor recorded for this order...
    const rows = journal.db.prepare("SELECT txid FROM mainnet_watch_payments").all() as { txid: string }[];
    assert.deepEqual(rows.map((x) => x.txid), [tx("2")]);
    // ...and remains a verified, auditable payment in the watcher's own view.
    const s = await t.scanner.observe();
    assert.deepEqual(
      s.payments.map((p) => `${p.txid}:${p.zatoshis}`).sort(),
      [`${tx("2")}:810`, `${tx("8")}:804`],
    );
    // A stale authorization is refused.
    assert.equal(authorized(r, b, Math.floor(Date.now() / 1000) + 200), false);
  } finally {
    t.close();
  }
});

test("an unbound (legacy) binding still sums every note and is refused, as before", async () => {
  const t = sharedAddress();
  try {
    const legacy = { ...t.binding({ orderId: "5".repeat(64) }), payment: undefined };
    const r = await observeMainnetWatch(new MainnetWatchJournal(":memory:"), t.scanner, legacy);
    assert.equal(r.receivedZatoshis, "1614");
    assert.equal(authorized(r, legacy), false);
  } finally {
    t.close();
  }
});

test("every substitution of the bound payment is refused", async () => {
  const t = sharedAddress();
  const fresh = () => new MainnetWatchJournal(":memory:");
  try {
    const cases: [string, Partial<MainnetOrderBinding>, Partial<NonNullable<MainnetOrderBinding["payment"]>>][] = [
      ["forged digest", { sourceEvidenceDigest: "f".repeat(64) }, {}],
      ["changed amount", { zatoshis: "811" }, {}],
      ["same amount, another txid", {}, { txid: tx("9") }],
      ["another output index", {}, { index: 1 }],
      ["another pool", {}, { pool: 2 }],
      ["changed inclusion height", {}, { height: t.PAY + 1 }],
    ];
    for (const [name, over, payment] of cases) {
      const b = t.binding(over, payment);
      const r = await observeMainnetWatch(fresh(), t.scanner, b);
      assert.equal(authorized(r, b), false, name);
    }
    // A changed recipient is refused outright.
    await assert.rejects(observeMainnetWatch(fresh(), t.scanner, t.binding({ address: "u1" + "z".repeat(60) })), /MAINNET_ORDER_WATCH_ACCOUNT_MISMATCH/);
    // A payment outside its own window cannot be bound.
    await assert.rejects(observeMainnetWatch(fresh(), t.scanner, t.binding({}, { windowEnd: t.PAY - 1 })), /INVALID_MAINNET_ORDER_BINDING/);
    // The earlier 804 payment cannot be substituted: it lies outside this order's window.
    const as804 = t.binding({ zatoshis: "804", sourceEvidenceDigest: t.ownership(tx("8")) }, { txid: tx("8"), height: t.OLD });
    await assert.rejects(observeMainnetWatch(fresh(), t.scanner, as804), /INVALID_MAINNET_ORDER_BINDING/);
    // Without its digest, a bound payment is not a valid binding.
    await assert.rejects(observeMainnetWatch(fresh(), t.scanner, t.binding({ sourceEvidenceDigest: undefined })), /INVALID_MAINNET_ORDER_BINDING/);
  } finally {
    t.close();
  }
});

test("another payment inside the order window is counted, so overpayment is still refused", async () => {
  const t = sharedAddress();
  try {
    t.w.update((c) => c.notes.push({ txid: tx("7"), height: t.W0 + 4, zatoshis: "50", address: ADDR }));
    t.seed(t.W0 + 4);
    const b = t.binding();
    const r = await observeMainnetWatch(new MainnetWatchJournal(":memory:"), t.scanner, b);
    assert.equal(r.receivedZatoshis, "860");
    assert.equal(authorized(r, b), false);
  } finally {
    t.close();
  }
});

test("the same amount from another transaction in the window does not replace the bound one", async () => {
  const t = sharedAddress();
  try {
    t.w.update((c) => {
      c.notes = c.notes.filter((n) => n.txid !== tx("2"));
      c.notes.push({ txid: tx("6"), height: t.W0 + 3, zatoshis: "810", address: ADDR });
    });
    t.seed(t.W0 + 3);
    const b = t.binding();
    const r = await observeMainnetWatch(new MainnetWatchJournal(":memory:"), t.scanner, b);
    assert.notEqual(r.status, "confirmed");
    assert.equal(authorized(r, b), false);
  } finally {
    t.close();
  }
});

test("incomplete segments, reorganizations and reuse by another order are refused", async () => {
  const t = sharedAddress();
  try {
    // Incomplete confirmation segment: the payment is only a pending candidate.
    rmSync(join(t.w.candidates, `${t.PAY + 5}-${blockHash(t.w.chain, t.PAY + 5)}.bin`));
    const pending = await observeMainnetWatch(new MainnetWatchJournal(":memory:"), t.scanner, t.binding());
    assert.notEqual(pending.status, "confirmed");
    assert.equal(authorized(pending, t.binding()), false);
    t.seed(t.PAY);
    // Reuse of the bound payment by another order, or an altered binding for this one.
    const journal = new MainnetWatchJournal(":memory:");
    assert.equal((await observeMainnetWatch(journal, t.scanner, t.binding())).status, "confirmed");
    await assert.rejects(observeMainnetWatch(journal, t.scanner, t.binding({ orderId: "6".repeat(64) })), /MAINNET_PAYMENT_REUSE_ACROSS_ORDERS/);
    await assert.rejects(observeMainnetWatch(journal, t.scanner, t.binding({}, { windowEnd: t.W1 + 1 })), /IMMUTABLE_MAINNET_ORDER_BINDING/);
    // A reorganization of the payment's block invalidates it.
    t.w.update((c) => {
      for (let h = t.PAY - 2; h <= c.tip; h++) c.hashes[h] = (h.toString(16) + "ef").padStart(64, "0");
    });
    t.seed(t.PAY);
    const reorged = await observeMainnetWatch(journal, t.scanner, t.binding());
    assert.notEqual(reorged.status, "confirmed");
    assert.equal(authorized(reorged, t.binding()), false);
  } finally {
    t.close();
  }
});
