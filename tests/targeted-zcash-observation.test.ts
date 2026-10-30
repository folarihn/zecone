// Targeted Zcash payment observation: compact discovery, then verification of
// only the candidate's raw confirmation segment, then the existing bridge.
// The REAL MainnetWatchScanner runs a fake observe-mainnet that enforces the Rust
// raw-block rule; the REAL candidateSegmentExporter promotes batches from a fake
// exporter with the real manifest checks; the REAL payments API and bridge
// attribute. Synthetic chain only: no network, keys, signing or broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { onboard, startHarness, type Harness } from "./helpers/payments-harness.ts";
import { fakeTargetedWatcher, blockHash, type TargetedChain } from "./helpers/fake-targeted-watcher.ts";
import { DEFAULT_CHECKOUT_ADDRESS } from "../services/payments/api.ts";
import type { PaymentStore } from "../services/payments/store.ts";
import {
  CANDIDATE_PENDING,
  TargetedObservationSource,
  candidateSegmentExporter,
  orderWindows,
  scopeCandidates,
  segmentPlan,
} from "../services/payments/targeted-observation.ts";
import { validateMainnetWatchSnapshot, type MainnetWatchSnapshot } from "../services/settlement/mainnet-watch.ts";

const ADDR = DEFAULT_CHECKOUT_ADDRESS;
const OTHER = "u1" + "q".repeat(60); // another owned address of the same account
const realNow = () => Math.floor(Date.now() / 1000);
const tx = (c: string) => c.repeat(64);
const TIP = 5000;
const BACKLOG = 1000;
const genesis = (): TargetedChain => ({ tip: TIP, hashes: {}, notes: [], defaultAddress: ADDR });

/** Fingerprint of the historical corpus and the worker checkpoint. */
function historical(state: string) {
  const root = join(state, "watch-worker");
  const corpus = join(root, "authenticated-blocks");
  const h = createHash("sha256");
  for (const name of readdirSync(corpus).sort()) h.update(name).update(readFileSync(join(corpus, name)));
  h.update(readFileSync(join(root, "checkpoint.json")));
  return h.digest("hex");
}

async function setup(chain = genesis(), opts: { targeted?: boolean } = {}) {
  const w = fakeTargetedWatcher(chain);
  // The historical worker is BACKLOG blocks behind; its corpus holds only old blocks.
  writeFileSync(
    join(w.state, "watch-worker", "checkpoint.json"),
    JSON.stringify({ schemaVersion: 1, network: "zcash-mainnet", startHeight: 1, nextHeight: TIP - BACKLOG + 1, lastHeight: TIP - BACKLOG, lastHash: blockHash(chain, TIP - BACKLOG) }),
  );
  for (let h = TIP - BACKLOG - 4; h <= TIP - BACKLOG; h++) w.seedCorpus(h);
  const exporter = candidateSegmentExporter({ stateDirectory: w.state, publicProbeConfig: join(w.dir, "unused.json"), exportMinimumConfirmations: 10, run: w.run });
  let store: PaymentStore | undefined;
  const source = new TargetedObservationSource(w.scanner(true), {
    receivingAddress: ADDR,
    exportMinimumConfirmations: 10,
    windows: () => orderWindows(store!, ADDR),
    exportSegment: (start, count) => exporter.exportSegment(start, count),
  });
  const h = await startHarness({
    mode: "monitor",
    demoMerchant: null,
    now: realNow,
    monitor: { authorized: true, source: opts.targeted === false ? w.scanner(true) : source, minimumConfirmations: 20, intervalSeconds: 3600 },
  });
  store = h.app.store;
  const before = historical(w.state);
  return {
    h,
    w,
    source,
    unchanged: () => historical(w.state) === before,
    close: async () => {
      await h.close();
      rmSync(w.dir, { recursive: true, force: true });
    },
  };
}

async function openOrder(h: Harness, amountUsd = "1.00") {
  assert.equal((await h.app.bridge!.tick()).ok, true); // fresh verified tip
  const m = await onboard(h);
  const created = await h.call("/api/v1/payments", { key: m.apiKey, body: { amountUsd } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { key: m.apiKey, payment: created.body.payment };
}

const state = async (h: Harness, key: string, id: string) =>
  (await h.call(`/api/v1/payments/${id}`, { key })).body.payment;

/** Mine one block at a time, ticking after each, until `predicate` or `limit` blocks. */
async function mineUntil(t: { h: Harness; w: ReturnType<typeof fakeTargetedWatcher> }, limit: number, predicate: () => Promise<boolean>) {
  const errors: string[] = [];
  for (let i = 0; i < limit; i++) {
    t.w.mine(1);
    const r = await t.h.app.bridge!.tick();
    if (!r.ok) errors.push(r.error!);
    if (await predicate()) return { blocks: i + 1, errors };
  }
  return { blocks: limit, errors };
}

test("a 1,000-block historical backlog does not block a new order; only its 20-block segment is exported", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    assert.equal(payment.zcashAddress, ADDR);
    t.w.mine(1);
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    const callsBefore = t.w.observeCalls();
    const ticks: string[] = [];
    let cur = await state(t.h, key, payment.id);
    for (let i = 0; i < 40 && cur.state !== "ZEC_CONFIRMED"; i++) {
      const r = await t.h.app.bridge!.tick();
      ticks.push(r.ok ? "ok" : r.error!);
      cur = await state(t.h, key, payment.id);
      // Discovery alone never advances the order.
      if (!r.ok) assert.equal(cur.state, "AWAITING_PAYMENT");
      if (cur.state !== "ZEC_CONFIRMED") t.w.mine(1);
    }
    assert.equal(cur.state, "ZEC_CONFIRMED");
    assert.equal(cur.detectedTxid, tx("2"));
    assert.ok(cur.confirmations >= 20);
    assert.match(cur.chainEvidence.paymentDigest, /^[0-9a-f]{64}$/);
    // Verified at 30 blocks deep: 20 confirmations, the last one 10 blocks final.
    assert.equal(t.w.chain.tip, TIP + 30);
    // Every failure was fail-closed "pending", never an export or verification error.
    assert.ok(ticks.slice(0, -1).every((e) => e === CANDIDATE_PENDING), ticks.join(","));
    // Performance: exactly the payment's segment, each block once, none of the backlog.
    assert.deepEqual(
      [...t.w.exported].sort((a, b) => a - b),
      Array.from({ length: 20 }, (_, i) => TIP + 1 + i),
    );
    assert.equal(new Set(t.w.exported).size, t.w.exported.length);
    assert.ok(t.w.exported.every((h) => h > TIP));
    // At most two compact scans per tick (discover, then verify).
    assert.ok(t.w.observeCalls() - callsBefore <= 2 * ticks.length);
    // Historical corpus and worker checkpoint are untouched.
    assert.ok(t.unchanged());
    assert.equal(readdirSync(t.w.corpus).filter((f) => f.endsWith(".bin")).length, 5);
    assert.equal(readdirSync(t.w.candidates).filter((f) => f.endsWith(".bin")).length, 20);
    assert.deepEqual(readdirSync(join(t.w.state, "watch-worker", "candidate-staging")), []);
  } finally {
    await t.close();
  }
});

test("compact discovery alone cannot mark an order paid, even without the targeted source", async () => {
  const t = await setup(genesis(), { targeted: false });
  try {
    const { key, payment } = await openOrder(t.h);
    const tipBefore = t.h.app.bridge!.health().tip;
    t.w.mine(40);
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    const r = await t.h.app.bridge!.tick();
    assert.equal(r.ok, false);
    assert.equal(r.error, CANDIDATE_PENDING);
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    // Nothing recorded, and the verified tip behind the heartbeat did not advance,
    // so absence can never be inferred past an unverified candidate.
    assert.equal(t.h.app.store.db.prepare(`SELECT COUNT(*) n FROM watch_notes`).get()!.n, 0);
    assert.equal(t.h.app.bridge!.health().tip, tipBefore);
    assert.equal(t.h.app.bridge!.health().ready, false);
    assert.deepEqual(t.w.exported, []);
  } finally {
    await t.close();
  }
});

test("a candidate is fully verified from raw blocks before any observation", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(30);
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    // Tampered bytes already sitting in the candidate directory are not trusted.
    const h0 = TIP + 1;
    writeFileSync(join(t.w.candidates, `${h0}-${blockHash(t.w.chain, h0)}.bin`), "forged block bytes");
    const r = await t.h.app.bridge!.tick();
    assert.equal(r.ok, false);
    assert.equal(r.error, "mainnet_watch_scan_failed");
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    rmSync(join(t.w.candidates, `${h0}-${blockHash(t.w.chain, h0)}.bin`));
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    const cur = await state(t.h, key, payment.id);
    assert.equal(cur.state, "ZEC_CONFIRMED");
    assert.equal(cur.chainEvidence.confirmations, 30);
  } finally {
    await t.close();
  }
});

test("a fake or forged txid is rejected and never exported or attributed", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(30);
    // Not in the two providers' compact block: the scan fails before any segment work.
    t.w.update((c) => c.notes.push({ txid: tx("9"), height: TIP + 1, zatoshis: "2000000", address: ADDR, failBeforeSegment: "mainnet_payment_not_in_compact_block" }));
    let r = await t.h.app.bridge!.tick();
    assert.equal(r.ok, false);
    assert.deepEqual(t.w.exported, []);
    // In a block, but full-transaction UFVK decryption does not yield our note.
    t.w.update((c) => {
      c.notes = [{ txid: tx("8"), height: TIP + 2, zatoshis: "2000000", address: ADDR, failAfterSegment: "mainnet_owned_note_decryption_failed" }];
    });
    r = await t.h.app.bridge!.tick();
    assert.equal(r.ok, false);
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    assert.equal(t.h.app.store.db.prepare(`SELECT COUNT(*) n FROM watch_notes`).get()!.n, 0);
  } finally {
    await t.close();
  }
});

test("the right amount to the wrong recipient is never exported or attributed", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(30);
    t.w.update((c) => c.notes.push({ txid: tx("3"), height: TIP + 1, zatoshis: "2000000", address: OTHER }));
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    assert.deepEqual(t.w.exported, []);
    assert.deepEqual(t.source.lastCandidates, []);
  } finally {
    await t.close();
  }
});

test("the right recipient with the wrong amount goes to manual review, not confirmation", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(30);
    t.w.update((c) => c.notes.push({ txid: tx("4"), height: TIP + 1, zatoshis: "1999999", address: ADDR }));
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    const cur = await state(t.h, key, payment.id);
    assert.equal(cur.state, "MANUAL_REVIEW");
    assert.notEqual(cur.state, "ZEC_CONFIRMED");
  } finally {
    await t.close();
  }
});

test("payments outside the allocation/expiry window are recorded but never pay the order", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    // Mined at the allocation height (discovered late): predates the checkout.
    t.w.mine(30);
    t.w.update((c) => c.notes.push({ txid: tx("5"), height: TIP, zatoshis: "2000000", address: ADDR }));
    const s = await t.w.scanner(true).observe();
    const scoped = scopeCandidates(s, orderWindows(t.h.app.store, ADDR), ADDR);
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].inWindow, false);
    assert.equal(scoped[0].paymentId, null);
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    assert.deepEqual(t.h.app.store.listUnattributed().map((d) => d.reason), ["note_predates_checkout"]);
    // Mined after the inclusion height: late deposit, manual review.
    const expiry = (await state(t.h, key, payment.id)).paymentExpiryHeight as number;
    t.w.mine(expiry + 31 - t.w.chain.tip);
    t.w.update((c) => c.notes.push({ txid: tx("6"), height: expiry + 1, zatoshis: "2000000", address: ADDR }));
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    const cur = await state(t.h, key, payment.id);
    assert.equal(cur.state, "MANUAL_REVIEW");
  } finally {
    await t.close();
  }
});

test("provider disagreement fails closed, during discovery and during segment export", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(30);
    t.w.update((c) => {
      c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR });
      c.fail = "mainnet_provider_disagreement";
    });
    assert.equal((await t.h.app.bridge!.tick()).ok, false);
    assert.deepEqual(t.w.exported, []);
    t.w.update((c) => {
      delete c.fail;
      c.rawDisagree = [TIP + 7];
    });
    const r = await t.h.app.bridge!.tick();
    assert.equal(r.ok, false);
    assert.equal(r.error, "WATCH_CANDIDATE_EXPORT_FAILED");
    // A failed batch is never promoted: no partial segment, staging cleaned.
    assert.deepEqual(readdirSync(t.w.candidates), []);
    assert.deepEqual(readdirSync(join(t.w.state, "watch-worker", "candidate-staging")), []);
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    assert.ok(t.unchanged());
  } finally {
    await t.close();
  }
});

test("missing raw blocks and insufficient confirmations fail closed", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(30);
    t.w.update((c) => {
      c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR });
      c.rawMissing = [TIP + 3];
    });
    assert.equal((await t.h.app.bridge!.tick()).error, "WATCH_CANDIDATE_EXPORT_FAILED");
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    // Never asks the exporter for blocks that are not yet final.
    const s = await t.w.scanner(true).observe();
    const [c] = scopeCandidates(s, orderWindows(t.h.app.store, ADDR), ADDR);
    assert.equal(segmentPlan({ missingHeight: s.tip - 5, segmentEnd: s.tip }, s.tip, 10), null);
    assert.deepEqual(segmentPlan(c, s.tip, 10), { startHeight: TIP + 1, count: 20 });
    assert.deepEqual(segmentPlan({ missingHeight: TIP + 1, segmentEnd: TIP + 20 }, TIP + 25, 10), { startHeight: TIP + 1, count: 15 });
  } finally {
    await t.close();
  }
  // Fewer than 20 confirmations (segment already authenticated) never confirms.
  const u = await setup();
  try {
    const { key, payment } = await openOrder(u.h);
    u.w.mine(5);
    u.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    for (let h = TIP + 1; h <= TIP + 5; h++) u.w.seedCorpus(h);
    assert.equal((await u.h.app.bridge!.tick()).ok, true);
    const cur = await state(u.h, key, payment.id);
    assert.equal(cur.state, "VERIFYING");
    assert.equal(cur.confirmations, 5);
  } finally {
    await u.close();
  }
});

test("a reorganization invalidates a pending candidate and a verified payment", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(15);
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    assert.equal((await t.h.app.bridge!.tick()).error, CANDIDATE_PENDING);
    assert.ok(t.w.exported.length > 0);
    // The candidate's block is reorganized away: nothing is ever attributed from the
    // segment that was exported for the old block hash.
    t.w.update((c) => {
      c.notes = [];
      for (let h = TIP + 1; h <= c.tip; h++) c.hashes[h] = (h.toString(16) + "cd").padStart(64, "0");
    });
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
  } finally {
    await t.close();
  }
  // A verified payment whose block changes goes to manual review.
  const u = await setup();
  try {
    const { key, payment } = await openOrder(u.h);
    u.w.mine(30);
    u.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    assert.equal((await u.h.app.bridge!.tick()).ok, true);
    assert.equal((await state(u.h, key, payment.id)).state, "ZEC_CONFIRMED");
    u.w.update((c) => {
      for (let h = TIP + 1; h <= c.tip; h++) c.hashes[h] = (h.toString(16) + "ef").padStart(64, "0");
    });
    // The re-mined note is a candidate again: its new segment is fetched and verified,
    // and the changed block sends the confirmed order to manual review.
    assert.equal((await u.h.app.bridge!.tick()).ok, true);
    const cur = await state(u.h, key, payment.id);
    assert.equal(cur.state, "MANUAL_REVIEW");
  } finally {
    await u.close();
  }
});

test("replayed and duplicate observations are rejected", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(30);
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    // Re-observing the same verified note neither re-attributes nor re-exports.
    const exported = t.w.exported.length;
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    assert.equal(t.w.exported.length, exported);
    assert.equal(t.h.app.store.db.prepare(`SELECT COUNT(*) n FROM watch_notes`).get()!.n, 1);
    assert.equal((await state(t.h, key, payment.id)).state, "ZEC_CONFIRMED");
    // A note can never be both verified and pending, or pending twice.
    const s = structuredClone(await t.w.scanner(true).observe()) as MainnetWatchSnapshot;
    const p = s.payments[0];
    const pending = {
      account: p.account, txid: p.txid, pool: p.pool, index: p.index, zatoshis: p.zatoshis, height: p.height,
      blockHash: p.blockHash, address: p.address, isChange: false as const, confirmations: p.confirmations,
      verified: false as const, evidence: "compact-scan-candidate" as const, missingHeight: p.height, missingHash: p.blockHash,
      segmentEnd: p.height + 19,
    };
    assert.throws(() => validateMainnetWatchSnapshot({ ...s, pendingCandidates: [pending] }), /DUPLICATE_MAINNET_PAYMENT/);
    const other = { ...pending, txid: tx("7") };
    assert.throws(() => validateMainnetWatchSnapshot({ ...s, payments: [], pendingCandidates: [other, other] }), /DUPLICATE_MAINNET_PAYMENT/);
    // A candidate can never claim to be verified or carry another segment.
    for (const bad of [{ verified: true }, { segmentEnd: p.height + 25 }, { missingHash: tx("1") }, { missingHeight: p.height - 1 }])
      assert.throws(() => validateMainnetWatchSnapshot({ ...s, payments: [], pendingCandidates: [{ ...other, ...bad } as never] }), /INVALID_MAINNET_PENDING_CANDIDATE/);
    assert.equal(s.pendingCandidates!.length, 0);
    // Without --defer-missing-segments a missing segment still fails the whole scan.
    t.w.update((c) => c.notes.push({ txid: tx("7"), height: c.tip, zatoshis: "1", address: ADDR }));
    await assert.rejects(t.w.scanner(false).observe(), /mainnet_watch_scan_failed/);
  } finally {
    await t.close();
  }
});

test("an unrelated owned deposit cannot be substituted for the order's payment", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(40);
    t.w.update((c) => {
      // Exact amount, inside the window, but to another owned address.
      c.notes.push({ txid: tx("a"), height: TIP + 2, zatoshis: "2000000", address: OTHER });
      // Exact amount to the checkout address, but mined before the order existed.
      c.notes.push({ txid: tx("b"), height: TIP - 3, zatoshis: "2000000", address: ADDR });
    });
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    t.w.update((c) => c.notes.push({ txid: tx("c"), height: TIP + 3, zatoshis: "2000000", address: ADDR }));
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    const cur = await state(t.h, key, payment.id);
    assert.equal(cur.state, "ZEC_CONFIRMED");
    assert.equal(cur.detectedTxid, tx("c"));
  } finally {
    await t.close();
  }
});

test("the targeted path has no signing, broadcast, payout or settlement capability", () => {
  const sources = [
    "services/payments/targeted-observation.ts",
    "tests/helpers/fake-targeted-watcher.ts",
  ].map((f) => readFileSync(f, "utf8"));
  for (const source of sources) {
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const i of imports)
      assert.doesNotMatch(i, /sign|submit|broadcast|relayer|executor|solana|base|keystore|payout|spend|wallet/i, i);
  }
  const module = sources[0];
  assert.doesNotMatch(module, /sendRawTransaction|broadcast\(|sign\(|privateKey|seed/);
  // The only process it may start is the read-only raw-block exporter.
  assert.match(module, /scripts\/mainnet-block-export\.ts/);
  // Snapshot sources that did not opt in never see pending candidates.
  assert.ok(existsSync("services/zcash-watch/src/main.rs"));
  assert.match(readFileSync("services/zcash-watch/src/main.rs", "utf8"), /if sources\.defer_missing_segments \{\n\s+snapshot\["pendingCandidates"\]/);
});
