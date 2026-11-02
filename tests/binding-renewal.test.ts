// Append-only renewal of an expired, unsettled order binding. The fake
// observe-mainnet enforces the raw-block rule; the watch journal, binding,
// renewal, authorization and fact reads are the real ones, on a real SQLite
// file. Synthetic only: no network, keys, signing or broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fakeTargetedWatcher, blockBytes, blockHash } from "./helpers/fake-targeted-watcher.ts";
import { DEFAULT_CHECKOUT_ADDRESS } from "../services/payments/api.ts";
import {
  assertMainnetPaymentAuthorization,
  MainnetWatchJournal,
  mainnetBindingDigest,
  observeMainnetWatch,
  pilotSessionWatchScanner,
  type MainnetOrderBinding,
} from "../services/settlement/mainnet-watch.ts";
import {
  assertBindingRenewalFacts,
  bindingRenewalApprovalText,
  bindingRenewalTerms,
  readBindingRenewalFacts,
  renewMainnetOrderBinding,
  type BindingRenewalFacts,
} from "../services/settlement/mainnet-binding-renewal.ts";

const ADDR = DEFAULT_CHECKOUT_ADDRESS;
const TIP = 5000;
const N = 20;
const tx = (c: string) => c.repeat(64);
const ORDER = "4".repeat(64);
const GOOD: BindingRenewalFacts = {
  orderState: "ZEC_CONFIRMED",
  payoutRecorded: false,
  spendSessionStates: ["FINALIZED"],
  baseSubmissions: 0,
  pilotSessionStates: ["ABORTED", "DRY_RUN"],
  sourceConsumed: false,
};

async function fixture() {
  const W0 = TIP + 30, W1 = W0 + 10, OLD = TIP + 1, PAY = W0 + 2;
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
  const ownership = (t: string) => createHash("sha256").update(t + "0").digest("hex");
  const T0 = Math.floor(Date.now() / 1000);
  const clock = { now: T0 };
  const path = join(w.dir, "watch.sqlite");
  const open = () => new MainnetWatchJournal(path, () => clock.now);
  const original: MainnetOrderBinding = {
    orderId: ORDER,
    account: "a".repeat(64),
    address: ADDR,
    zatoshis: "810",
    expires: T0 + 60,
    sourceEvidenceDigest: ownership(tx("2")),
    payment: { txid: tx("2"), pool: 3, index: 0, height: PAY, windowStart: W0, windowEnd: W1 },
  };
  const scanner = pilotSessionWatchScanner(
    { watchWallet: w.wallet, watchBinary: process.execPath, authenticatedBlocks: w.corpus, candidateBlocks: w.candidates, receivingAddress: ADDR },
    w.policy,
    w.executableArgsPrefix,
  );
  // The order was bound and its payment confirmed before the binding expired.
  const journal = open();
  const first = await observeMainnetWatch(journal, scanner, original);
  assert.equal(first.status, "confirmed");
  const commitment = first.paymentDigest!;
  clock.now = T0 + 100; // the original binding (T0 + 60) has now expired
  const snapshot = () => scanner.observe(journal.checkpointHeight());
  const approval = (j = journal, window = 3600, b = original) =>
    bindingRenewalApprovalText(bindingRenewalTerms(j, b, commitment, window));
  const renew = async (over: Partial<Parameters<typeof renewMainnetOrderBinding>[1]> = {}, j = journal) =>
    renewMainnetOrderBinding(j, {
      original,
      paymentCommitment: commitment,
      windowSeconds: 3600,
      approval: approval(j),
      snapshot: await snapshot(),
      facts: GOOD,
      ...over,
    });
  const orderRow = (j = journal) => j.db.prepare("SELECT * FROM mainnet_watch_orders WHERE order_id=?").get(ORDER);
  const renewals = (j = journal) => j.db.prepare("SELECT * FROM mainnet_watch_binding_renewals ORDER BY generation").all() as Record<string, any>[];
  return {
    w, W0, W1, OLD, PAY, T0, clock, path, open, journal, original, commitment, scanner, seed, ownership,
    snapshot, approval, renew, orderRow, renewals,
    close: () => { journal.close(); rmSync(w.dir, { recursive: true, force: true }); },
  };
}

const authorized = (j: MainnetWatchJournal, r: Awaited<ReturnType<typeof observeMainnetWatch>>, commitment: string, now: number) => {
  try {
    return assertMainnetPaymentAuthorization(r, { orderId: ORDER, paymentDigest: commitment, zatoshis: "810" }, now);
  } catch {
    return false;
  }
};

test("1-3, 20: an expired, unchanged, unsettled binding gets one append-only, bounded renewal", async () => {
  const t = await fixture();
  try {
    const before = t.orderRow();
    // Without a renewal the expired binding cannot be refreshed or reused.
    await assert.rejects(observeMainnetWatch(t.journal, t.scanner, { ...t.original, expires: t.clock.now + 3600 }), /IMMUTABLE_MAINNET_ORDER_BINDING/);
    await assert.rejects(observeMainnetWatch(t.journal, t.scanner, t.original), /INVALID_MAINNET_ORDER_BINDING/);
    const r = await t.renew();
    assert.equal(r.generation, 1);
    assert.equal(r.expires, t.clock.now + 3600);
    assert.deepEqual({ ...r.renewedBinding, expires: t.original.expires }, t.original);
    // The renewed binding re-verifies and authorizes the exact payment.
    const obs = await observeMainnetWatch(t.journal, t.scanner, r.renewedBinding);
    assert.equal(obs.status, "confirmed");
    assert.equal(obs.receivedZatoshis, "810");
    assert.ok(authorized(t.journal, obs, t.commitment, t.clock.now));
    // 2. The original row is byte-for-byte unchanged and cannot be rewritten.
    assert.deepEqual(t.orderRow(), before);
    assert.throws(() => t.journal.db.prepare("UPDATE mainnet_watch_orders SET expires=expires+1").run(), /APPEND_ONLY_MAINNET_BINDING_JOURNAL/);
    assert.throws(() => t.journal.db.prepare("DELETE FROM mainnet_watch_orders").run(), /APPEND_ONLY_MAINNET_BINDING_JOURNAL/);
    // 3. The renewal is an auditable, append-only record chained to the original.
    const [row] = t.renewals();
    assert.equal(row.previous_binding_digest, mainnetBindingDigest(t.original));
    assert.equal(row.original_binding_digest, mainnetBindingDigest(t.original));
    assert.equal(row.renewed_binding_digest, r.renewedBindingDigest);
    assert.equal(row.payment_commitment, t.commitment);
    assert.equal(JSON.parse(row.evidence_json).paymentDigest, t.commitment);
    assert.throws(() => t.journal.db.prepare("UPDATE mainnet_watch_binding_renewals SET expires=0").run(), /APPEND_ONLY/);
    assert.throws(() => t.journal.db.prepare("DELETE FROM mainnet_watch_binding_renewals").run(), /APPEND_ONLY/);
    // 20. The window is bounded by the checkout settlement policy.
    for (const window of [0, 299, 3601, 6 * 3600])
      assert.throws(() => bindingRenewalTerms(t.journal, t.original, t.commitment, window), /RENEWAL_WINDOW_INVALID/);
  } finally {
    t.close();
  }
});

test("4-6: no renewal before expiry, no duplicate active renewal, no replay after consumption or expiry", async () => {
  const t = await fixture();
  try {
    t.clock.now = t.T0 + 30; // 4. original still valid
    await assert.rejects(t.renew(), /RENEWAL_ORIGINAL_NOT_EXPIRED/);
    assert.equal(t.renewals().length, 0);
    t.clock.now = t.T0 + 100;
    const r = await t.renew();
    // 5. A second renewal while one is active is refused.
    await assert.rejects(t.renew(), /RENEWAL_ACTIVE_RENEWAL_EXISTS/);
    assert.equal(t.renewals().length, 1);
    // 6. Single use: an execution consumes it; no second execution, and no
    // other process may use it afterwards.
    assert.equal(t.journal.consumeRenewal(r.renewedBinding, t.commitment, "session-a"), r.renewalId);
    assert.throws(() => t.journal.consumeRenewal(r.renewedBinding, t.commitment, "session-b"), /MAINNET_BINDING_RENEWAL_CONSUMED/);
    assert.equal((await observeMainnetWatch(t.journal, t.scanner, r.renewedBinding)).status, "confirmed");
    const other = t.open();
    try {
      await assert.rejects(observeMainnetWatch(other, t.scanner, r.renewedBinding), /IMMUTABLE_MAINNET_ORDER_BINDING/);
      assert.throws(() => other.consumeRenewal(r.renewedBinding, t.commitment, "session-c"), /MAINNET_BINDING_RENEWAL_CONSUMED/);
    } finally {
      other.close();
    }
    assert.throws(() => t.journal.db.prepare("DELETE FROM mainnet_watch_binding_renewal_consumptions").run(), /APPEND_ONLY/);
    // A consumption must carry the renewal's own payment commitment.
    const fresh = t.open();
    try {
      assert.throws(() => fresh.consumeRenewal(r.renewedBinding, "0".repeat(64), "x"), /MAINNET_BINDING_RENEWAL_INVALID/);
    } finally {
      fresh.close();
    }
    // Fail closed after expiry.
    t.clock.now = r.expires;
    assert.throws(() => t.journal.bind(r.renewedBinding), /INVALID_MAINNET_ORDER_BINDING/);
  } finally {
    t.close();
  }
});

test("7-12: every immutable field is bound; a changed field cannot renew or bind", async () => {
  const t = await fixture();
  try {
    const p = t.original.payment!;
    const changed: [string, MainnetOrderBinding, RegExp][] = [
      ["order id", { ...t.original, orderId: "5".repeat(64) }, /RENEWAL_ORIGINAL_BINDING_NOT_FOUND/],
      ["recipient", { ...t.original, address: "u1" + "z".repeat(60) }, /RENEWAL_ORIGINAL_BINDING_MISMATCH/],
      ["amount", { ...t.original, zatoshis: "811" }, /RENEWAL_ORIGINAL_BINDING_MISMATCH/],
      ["txid", { ...t.original, payment: { ...p, txid: tx("9") } }, /RENEWAL_ORIGINAL_BINDING_MISMATCH/],
      ["pool", { ...t.original, payment: { ...p, pool: 4 } }, /RENEWAL_ORIGINAL_BINDING_MISMATCH/],
      ["output index", { ...t.original, payment: { ...p, index: 1 } }, /RENEWAL_ORIGINAL_BINDING_MISMATCH/],
      ["inclusion height", { ...t.original, payment: { ...p, height: p.height + 1 } }, /RENEWAL_ORIGINAL_BINDING_MISMATCH/],
      ["window", { ...t.original, payment: { ...p, windowEnd: p.windowEnd + 1 } }, /RENEWAL_ORIGINAL_BINDING_MISMATCH/],
      ["ownership digest", { ...t.original, sourceEvidenceDigest: "f".repeat(64) }, /RENEWAL_ORIGINAL_BINDING_MISMATCH/],
    ];
    for (const [name, b, error] of changed)
      assert.throws(() => bindingRenewalTerms(t.journal, b, t.commitment, 3600), error, name);
    // 12. A changed payment commitment is not re-verified (nothing written).
    const wrong = "0".repeat(64);
    await assert.rejects(
      t.renew({ paymentCommitment: wrong, approval: bindingRenewalApprovalText(bindingRenewalTerms(t.journal, t.original, wrong, 3600)) }),
      /RENEWAL_PAYMENT_NOT_REVERIFIED/,
    );
    assert.equal(t.renewals().length, 0);
    // After a valid renewal, a binding that changes any immutable field but
    // keeps the renewed expiry is still refused.
    const r = await t.renew();
    for (const [name, b] of changed.slice(1))
      await assert.rejects(observeMainnetWatch(t.journal, t.scanner, { ...b, expires: r.expires }), /IMMUTABLE_MAINNET_ORDER_BINDING|MAINNET_ORDER_WATCH_ACCOUNT_MISMATCH|INVALID_MAINNET_ORDER_BINDING/, name);
  } finally {
    t.close();
  }
});

test("13-15: no substitution by other payments at the shared address, and a reorganization invalidates renewal", async () => {
  const t = await fixture();
  try {
    // 13. The earlier 804 payment at the same address cannot be the renewed payment.
    assert.throws(
      () => bindingRenewalTerms(t.journal, { ...t.original, zatoshis: "804", sourceEvidenceDigest: t.ownership(tx("8")), payment: { ...t.original.payment!, txid: tx("8"), height: t.OLD } }, t.commitment, 3600),
      /RENEWAL_ORIGINAL_BINDING_MISMATCH/,
    );
    // 14. The same amount from another transaction cannot replace the bound one.
    t.w.update((c) => {
      c.notes = c.notes.filter((n) => n.txid !== tx("2"));
      c.notes.push({ txid: tx("6"), height: t.W0 + 3, zatoshis: "810", address: ADDR });
    });
    t.seed(t.W0 + 3);
    await assert.rejects(t.renew(), /RENEWAL_PAYMENT_NOT_REVERIFIED/);
    assert.equal(t.renewals().length, 0);
  } finally {
    t.close();
  }
  const u = await fixture();
  try {
    // 15. A reorganization of the payment's block invalidates renewal.
    u.w.update((c) => {
      for (let h = u.PAY - 2; h <= c.tip; h++) c.hashes[h] = (h.toString(16) + "ef").padStart(64, "0");
    });
    u.seed(u.PAY);
    await assert.rejects(u.renew(), /RENEWAL_PAYMENT_NOT_REVERIFIED|RENEWAL_PAYMENT_EVIDENCE_MISMATCH/);
    assert.equal(u.renewals().length, 0);
  } finally {
    u.close();
  }
});

test("16: any preparation for signing, signature, broadcast, uncertainty, completion or refund blocks renewal", async () => {
  assert.equal(assertBindingRenewalFacts(GOOD), undefined);
  const blocked: [string, Partial<BindingRenewalFacts>, RegExp][] = [
    ["completed order", { orderState: "COMPLETED" }, /RENEWAL_ORDER_NOT_ELIGIBLE/],
    ["refunded order", { orderState: "REFUNDED" }, /RENEWAL_ORDER_NOT_ELIGIBLE/],
    ["manual review", { orderState: "MANUAL_REVIEW" }, /RENEWAL_ORDER_NOT_ELIGIBLE/],
    ["payout recorded", { payoutRecorded: true }, /RENEWAL_ORDER_NOT_ELIGIBLE/],
    ["zcash submitted", { spendSessionStates: ["SUBMITTED"] }, /RENEWAL_ZCASH_SESSION_NOT_FINALIZED/],
    ["no zcash session", { spendSessionStates: [] }, /RENEWAL_ZCASH_SESSION_NOT_FINALIZED/],
    ["base submission", { baseSubmissions: 1 }, /RENEWAL_BASE_SETTLEMENT_EXISTS/],
    ["source consumed", { sourceConsumed: true }, /RENEWAL_BASE_SETTLEMENT_EXISTS/],
    ...["RUNNING", "SIGNING", "SIGNED", "SUBMITTING", "BROADCAST", "UNCERTAIN", "UNCERTAIN_SIGNING", "FINALIZED"].map(
      (s) => [`pilot ${s}`, { pilotSessionStates: ["ABORTED", s] }, /RENEWAL_BASE_SETTLEMENT_EXISTS/] as [string, Partial<BindingRenewalFacts>, RegExp],
    ),
  ];
  for (const [name, over, error] of blocked) assert.throws(() => assertBindingRenewalFacts({ ...GOOD, ...over }), error, name);

  // The facts come from the operator's real journals, read-only.
  const t = await fixture();
  try {
    const db = (name: string, sql: string) => {
      const p = join(t.w.dir, name);
      const d = new DatabaseSync(p);
      d.exec(sql);
      d.close();
      return p;
    };
    const paths = {
      payments: db("payments.sqlite", "CREATE TABLE payments(id TEXT PRIMARY KEY, state TEXT, payout_tx_hash TEXT); INSERT INTO payments VALUES('pay_x','ZEC_CONFIRMED',NULL);"),
      spendJournal: db("spend.sqlite", `CREATE TABLE spend_sessions_v3(session_id TEXT, txid TEXT, state TEXT); INSERT INTO spend_sessions_v3 VALUES('s','${tx("2")}','FINALIZED');`),
      submissions: db("submissions.sqlite", "CREATE TABLE mainnet_submissions(order_id TEXT, source_commitment TEXT, state TEXT);"),
      pilotSessions: db("pilot.sqlite", `CREATE TABLE pilot_sessions(id TEXT, source TEXT, state TEXT); CREATE TABLE pilot_consumed_sources(source TEXT, session_id TEXT); INSERT INTO pilot_sessions VALUES('a','${t.commitment}','ABORTED');`),
    };
    const ids = { paymentId: "pay_x", txid: tx("2"), orderId: ORDER, paymentCommitment: t.commitment };
    assert.deepEqual(readBindingRenewalFacts(paths, ids), { ...GOOD, pilotSessionStates: ["ABORTED"] });
    const edit = (p: string, sql: string) => { const d = new DatabaseSync(p); d.exec(sql); d.close(); };
    edit(paths.pilotSessions, `INSERT INTO pilot_sessions VALUES('b','${t.commitment}','SIGNED');`);
    const facts = readBindingRenewalFacts(paths, ids);
    assert.throws(() => assertBindingRenewalFacts(facts), /RENEWAL_BASE_SETTLEMENT_EXISTS/);
    await assert.rejects(t.renew({ facts }), /RENEWAL_BASE_SETTLEMENT_EXISTS/);
    edit(paths.submissions, `INSERT INTO mainnet_submissions VALUES('${ORDER}','${t.commitment}','broadcast');`);
    assert.equal(readBindingRenewalFacts(paths, ids).baseSubmissions, 1);
    assert.throws(() => readBindingRenewalFacts({ ...paths, submissions: join(t.w.dir, "missing.sqlite") }, ids), /RENEWAL_JOURNAL_MISSING/);
    assert.equal(t.renewals().length, 0);
  } finally {
    t.close();
  }
});

test("17: a renewal needs its own exact approval and grants no signing or broadcast", async () => {
  const t = await fixture();
  try {
    await assert.rejects(t.renew({ approval: "SIGN_EXACT_MAINNET_BUNDLE" }), /RENEWAL_EXACT_APPROVAL_REQUIRED/);
    const exact = t.approval();
    await assert.rejects(t.renew({ approval: exact.slice(0, -1) + (exact.endsWith("0") ? "1" : "0") }), /RENEWAL_EXACT_APPROVAL_REQUIRED/);
    const r = await t.renew();
    assert.deepEqual(Object.keys(r).sort(), ["evidence", "expires", "generation", "renewalId", "renewedBinding", "renewedBindingDigest", "termsDigest"]);
    // The payout session consumes a renewal only for an execution, before it
    // starts, and its SIGN and BROADCAST approvals are unchanged.
    const session = readFileSync(new URL("../scripts/mainnet-pilot-session.ts", import.meta.url), "utf8");
    assert.match(session, /if \(mode === "--run"\)\s+watch\.consumeRenewal\(c\.watchBinding, c\.sourceCommitment, sessionId\);\s+const result = await runPilotSession\(/);
    const runner = readFileSync(new URL("../services/settlement/mainnet-pilot-session.ts", import.meta.url), "utf8");
    assert.match(runner, /await confirm\("SIGN"\)/);
    assert.match(runner, /if \(options\.dryRun\)/);
  } finally {
    t.close();
  }
});

test("18-19: renewals and consumptions survive restart; concurrent renewals record at most one", async () => {
  const t = await fixture();
  const handles: MainnetWatchJournal[] = [];
  const track = (j: MainnetWatchJournal) => (handles.push(j), j);
  try {
    const a = track(t.open()), b = track(t.open());
    const terms = [bindingRenewalApprovalText(bindingRenewalTerms(a, t.original, t.commitment, 3600)), bindingRenewalApprovalText(bindingRenewalTerms(b, t.original, t.commitment, 3600))];
    assert.equal(terms[0], terms[1]);
    const snap = await t.snapshot();
    const results = [a, b].map((j, i) => {
      try {
        return renewMainnetOrderBinding(j, { original: t.original, paymentCommitment: t.commitment, windowSeconds: 3600, approval: terms[i], snapshot: snap, facts: GOOD });
      } catch (e) {
        return (e as Error).message;
      }
    });
    assert.equal(results.filter((r) => typeof r !== "string").length, 1);
    // The loser's approved terms named generation 1, which no longer exists.
    assert.match(String(results.find((r) => typeof r === "string")), /RENEWAL_EXACT_APPROVAL_REQUIRED|RENEWAL_ACTIVE_RENEWAL_EXISTS|RENEWAL_CONCURRENT_RENEWAL/);
    assert.equal(t.renewals(a).length, 1);
    const r = results.find((x) => typeof x !== "string") as Exclude<(typeof results)[number], string>;
    a.consumeRenewal(r.renewedBinding, t.commitment, "session-a");
    for (const j of [...handles, t.journal]) j.close();
    handles.length = 0;
    // 18. A restarted process sees the renewal and its consumption.
    const restarted = track(t.open());
    {
      assert.equal(t.renewals(restarted).length, 1);
      assert.throws(() => restarted.consumeRenewal(r.renewedBinding, t.commitment, "session-b"), /MAINNET_BINDING_RENEWAL_CONSUMED/);
      await assert.rejects(observeMainnetWatch(restarted, t.scanner, r.renewedBinding), /IMMUTABLE_MAINNET_ORDER_BINDING/);
      // The payment record and its cross-order replay protection are intact.
      await assert.rejects(
        observeMainnetWatch(restarted, t.scanner, { ...t.original, orderId: "6".repeat(64), expires: t.clock.now + 600 }),
        /MAINNET_PAYMENT_REUSE_ACROSS_ORDERS/,
      );
    }
  } finally {
    for (const j of handles) j.close();
    try { t.journal.close(); } catch { /* already closed */ }
    rmSync(t.w.dir, { recursive: true, force: true });
  }
});
