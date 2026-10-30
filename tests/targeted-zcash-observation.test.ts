// Targeted Zcash payment observation: compact discovery, then verification of
// only the candidate's 20-block raw confirmation segment, then the existing
// bridge. The REAL MainnetWatchScanner runs a fake observe-mainnet that enforces
// the Rust raw-block rule; the REAL exportCandidateSegment policy runs over fake
// providers; the REAL promotion, payments API and bridge attribute. The real
// Rust `verify-block` binary is exercised on a real mainnet block fixture.
// Synthetic chain only: no network, keys, signing or broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  segmentRequest,
} from "../services/payments/targeted-observation.ts";
import {
  CANDIDATE_SEGMENT_MANIFEST,
  exportCandidateSegment,
  promoteCandidateSegment,
} from "../services/operations/candidate-segment-export.ts";
import { promoteAuthenticatedBatch, validateWatchWorkerConfig } from "../services/operations/mainnet-watch-worker.ts";
import { paymentWindow, ZCASH_TARGET_SPACING_SECONDS, DEFAULT_OBSERVATION_GRACE_SECONDS, MAX_INCLUSION_BLOCKS } from "../services/payments/payment-window.ts";
import { rustVerifyBlock } from "../scripts/mainnet-candidate-segment-export.ts";
import { validateMainnetWatchSnapshot, type MainnetWatchSnapshot } from "../services/settlement/mainnet-watch.ts";

const ADDR = DEFAULT_CHECKOUT_ADDRESS;
const OTHER = "u1" + "q".repeat(60); // another owned address of the same account
const realNow = () => Math.floor(Date.now() / 1000);
const tx = (c: string) => c.repeat(64);
const TIP = 5000;
const BACKLOG = 1000;
const N = 20;
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
  const exporter = candidateSegmentExporter({ stateDirectory: w.state, publicProbeConfig: join(w.dir, "unused.json"), run: w.run });
  let store: PaymentStore | undefined;
  const source = new TargetedObservationSource(w.scanner(true), {
    receivingAddress: ADDR,
    paymentConfirmations: N,
    windows: () => orderWindows(store!, ADDR),
    exportSegment: (request) => exporter.exportSegment(request),
  });
  const h = await startHarness({
    mode: "monitor",
    demoMerchant: null,
    now: realNow,
    monitor: { authorized: true, source: opts.targeted === false ? w.scanner(true) : source, minimumConfirmations: N, intervalSeconds: 3600 },
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
const noteCount = (h: Harness) => (h.app.store.db.prepare(`SELECT COUNT(*) n FROM watch_notes`).get() as { n: number }).n;

test("a 1,000-block backlog does not block a new order; it verifies at exactly 20 confirmations from 20 exported blocks", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    assert.equal(payment.zcashAddress, ADDR);
    t.w.mine(1); // tip H: 1 payment confirmation
    const H = TIP + 1;
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: H, zatoshis: "2000000", address: ADDR }));
    const callsBefore = t.w.observeCalls();
    const ticks: { confirmations: number; result: string; state: string }[] = [];
    for (;;) {
      const r = await t.h.app.bridge!.tick();
      const cur = await state(t.h, key, payment.id);
      ticks.push({ confirmations: t.w.chain.tip - H + 1, result: r.ok ? "ok" : r.error!, state: cur.state });
      if (cur.state === "ZEC_CONFIRMED" || ticks.length > 40) break;
      t.w.mine(1);
    }
    // 1..19 payment confirmations: pending, fail closed, nothing exported, order untouched.
    assert.deepEqual(
      ticks.slice(0, -1),
      Array.from({ length: N - 1 }, (_, i) => ({ confirmations: i + 1, result: CANDIDATE_PENDING, state: "AWAITING_PAYMENT" })),
    );
    // Exactly 20 payment confirmations (tip H+19): verified, not 30.
    assert.deepEqual(ticks.at(-1), { confirmations: N, result: "ok", state: "ZEC_CONFIRMED" });
    assert.equal(t.w.chain.tip, H + N - 1);
    const cur = await state(t.h, key, payment.id);
    assert.equal(cur.detectedTxid, tx("2"));
    assert.equal(cur.confirmations, N);
    assert.match(cur.chainEvidence.paymentDigest, /^[0-9a-f]{64}$/);
    // Performance: exactly the payment's 20-block segment, once, at tip H+19; no backlog block.
    assert.deepEqual(t.w.exported, Array.from({ length: N }, (_, i) => H + i));
    assert.deepEqual(t.w.exportTips, [H + N - 1]);
    assert.ok(t.w.exported.every((height) => height > TIP - BACKLOG));
    assert.ok(t.w.observeCalls() - callsBefore <= 2 * ticks.length);
    // Historical corpus and worker checkpoint are byte-for-byte unchanged.
    assert.ok(t.unchanged());
    assert.equal(readdirSync(t.w.corpus).filter((f) => f.endsWith(".bin")).length, 5);
    assert.equal(readdirSync(t.w.candidates).filter((f) => f.endsWith(".bin")).length, N);
    assert.deepEqual(readdirSync(join(t.w.state, "watch-worker", "candidate-staging")), []);
  } finally {
    await t.close();
  }
});

test("confirmation boundary: 19 is pending, 20 and 30 request exactly the 20-block segment", () => {
  const H = 7000;
  const at = (confirmations: number) => ({
    height: H,
    txid: tx("2"),
    confirmations,
    segmentEnd: H + Math.min(confirmations, N) - 1,
  });
  assert.equal(segmentRequest(at(1), N), null);
  assert.equal(segmentRequest(at(19), N), null);
  assert.deepEqual(segmentRequest(at(20), N), { paymentHeight: H, paymentTxid: tx("2"), paymentConfirmations: N });
  assert.deepEqual(segmentRequest(at(30), N), { paymentHeight: H, paymentTxid: tx("2"), paymentConfirmations: N });
  // A candidate whose reported segment is not exactly H..H+19 is never requested.
  assert.equal(segmentRequest({ ...at(20), segmentEnd: H + 18 }, N), null);
});

test("candidate-segment policy: exact boundary against probe depth (tip - height)", async () => {
  const w = fakeTargetedWatcher({ ...genesis(), tip: TIP + 18 });
  const H = TIP;
  const out = (name: string) => join(w.dir, name);
  try {
    w.update((c) => c.notes.push({ txid: tx("2"), height: H, zatoshis: "1", address: ADDR }));
    const request = { paymentHeight: H, paymentTxid: tx("2"), paymentConfirmations: N };
    // Tip H+18: probe depth 18, payment confirmations 19.
    await assert.rejects(exportCandidateSegment(w.deps, { ...request, output: out("a") }), /CANDIDATE_SEGMENT_INSUFFICIENT_CONFIRMATIONS/);
    assert.equal(existsSync(out("a")), false);
    // Tip H+19: probe depth 19, payment confirmations exactly 20.
    w.mine(1);
    const m = await exportCandidateSegment(w.deps, { ...request, output: out("b") });
    assert.equal(m.mode, "CANDIDATE_SEGMENT");
    assert.equal(m.startHeight, H);
    assert.equal(m.endHeight, H + 19);
    assert.equal(m.agreedTip, H + 19);
    assert.equal(m.blocks.length, N);
    // Tip H+29: still exactly H..H+19.
    w.mine(10);
    const later = await exportCandidateSegment(w.deps, { ...request, output: out("c") });
    assert.deepEqual([later.startHeight, later.endHeight, later.agreedTip], [H, H + 19, H + 29]);
    // An explicit policy, never a generic minimum of zero or the historical 10.
    for (const paymentConfirmations of [0, 1, 10, 19, 100])
      await assert.rejects(exportCandidateSegment(w.deps, { ...request, paymentConfirmations, output: out(`bad-${paymentConfirmations}`) }), /CANDIDATE_SEGMENT_REQUEST_INVALID/);
    await assert.rejects(exportCandidateSegment(w.deps, { ...request, paymentTxid: "zz", output: out("bad-txid") }), /CANDIDATE_SEGMENT_REQUEST_INVALID/);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("candidate-segment policy rejects every provider, byte, continuity, PoW, txid and chain-change fault", async () => {
  const H = TIP;
  const cases: [string, (c: TargetedChain) => void, RegExp][] = [
    ["lightwalletd disagreement at a middle height", (c) => (c.providerDisagree = [H + 11]), /CANDIDATE_SEGMENT_PROVIDER_DISAGREEMENT/],
    ["lightwalletd disagreement at the segment end", (c) => (c.providerDisagree = [H + 19]), /CANDIDATE_SEGMENT_PROVIDER_DISAGREEMENT/],
    ["raw-block byte disagreement", (c) => (c.rawDisagree = [H + 4]), /zcash_raw_block_provider_disagreement/],
    ["missing raw block", (c) => (c.rawMissing = [H + 19]), /zcash_raw_block_unavailable/],
    ["broken continuity", (c) => (c.brokenPrev = [H + 7]), /CANDIDATE_SEGMENT_DISCONTINUITY/],
    ["invalid proof of work", (c) => (c.badPow = [H + 2]), /insufficient_proof_of_work/],
    ["payment txid missing", (c) => (c.omitTxids = [H]), /transaction_not_in_block/],
    ["payment txid duplicated", (c) => (c.extraTxids = { [H]: [tx("2")] }), /transaction_not_in_block/],
  ];
  for (const [name, fault, expected] of cases) {
    const w = fakeTargetedWatcher({ ...genesis(), tip: H + 19 });
    try {
      w.update((c) => {
        c.notes.push({ txid: tx("2"), height: H, zatoshis: "1", address: ADDR });
        fault(c);
      });
      const output = join(w.dir, "segment");
      await assert.rejects(exportCandidateSegment(w.deps, { paymentHeight: H, paymentTxid: tx("2"), paymentConfirmations: N, output }), expected, name);
      assert.equal(existsSync(output), false, name);
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }
  // The tip falls below the segment end during export.
  let w = fakeTargetedWatcher({ ...genesis(), tip: H + 19 });
  try {
    w.update((c) => c.notes.push({ txid: tx("2"), height: H, zatoshis: "1", address: ADDR }));
    const wt = w;
    wt.onProbe((_h, count) => {
      if (count === 3) wt.update((c) => (c.tip = H + 18));
    });
    await assert.rejects(
      exportCandidateSegment(w.deps, { paymentHeight: H, paymentTxid: tx("2"), paymentConfirmations: N, output: join(w.dir, "s") }),
      /CANDIDATE_SEGMENT_TIP_CHANGED|height_above_tip/,
    );
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
  // A block hash changes after it was fetched (reorganization during export).
  w = fakeTargetedWatcher({ ...genesis(), tip: H + 19 });
  try {
    w.update((c) => c.notes.push({ txid: tx("2"), height: H, zatoshis: "1", address: ADDR }));
    const wc = w;
    wc.onProbe((_h, count) => {
      if (count === N + 1) wc.update((c) => (c.hashes[H + 5] = "5".repeat(64)));
    });
    const output = join(w.dir, "s");
    await assert.rejects(
      exportCandidateSegment(w.deps, { paymentHeight: H, paymentTxid: tx("2"), paymentConfirmations: N, output }),
      /CANDIDATE_SEGMENT_CHAIN_CHANGED/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("historical exporter, worker policy and promotion keep their 10-block finality floor", async () => {
  // scripts/mainnet-block-export.ts is not used by targeted observation and still
  // refuses any block shallower than its minimum (at least 10).
  const historicalExporter = readFileSync("scripts/mainnet-block-export.ts", "utf8");
  assert.match(historicalExporter, /minimumConfirmations < 10 \|\|/);
  assert.match(historicalExporter, /\(probe\.confirmations as number\) < minimumConfirmations/);
  const targeted = readFileSync("services/payments/targeted-observation.ts", "utf8");
  assert.match(targeted, /const EXPORTER = fileURLToPath\(new URL\("\.\.\/\.\.\/scripts\/mainnet-candidate-segment-export\.ts"/);
  assert.doesNotMatch(targeted, /URL\("[^"]*mainnet-block-export/);
  assert.doesNotMatch(targeted, /promoteAuthenticatedBatch|exportMinimumConfirmations/);
  const base = { enabled: true, network: "zcash-mainnet" as const, startHeight: 1, minimumConfirmations: 20, exportMinimumConfirmations: 10, batchSize: 20, maxRetries: 3, retryBaseMs: 1000, maximumLagBlocks: 2, maximumScanAgeSeconds: 1800 };
  validateWatchWorkerConfig(base);
  for (const exportMinimumConfirmations of [0, 1, 9])
    assert.throws(() => validateWatchWorkerConfig({ ...base, exportMinimumConfirmations }), /WATCH_WORKER_CONFIG_INVALID/);
  // A candidate segment can never be promoted into the historical corpus, and a
  // segment is only promoted for the exact payment it was exported for.
  const w = fakeTargetedWatcher({ ...genesis(), tip: TIP + 19 });
  try {
    w.update((c) => c.notes.push({ txid: tx("2"), height: TIP, zatoshis: "1", address: ADDR }));
    const batch = join(w.dir, "batch");
    await exportCandidateSegment(w.deps, { paymentHeight: TIP, paymentTxid: tx("2"), paymentConfirmations: N, output: batch });
    assert.ok(existsSync(join(batch, CANDIDATE_SEGMENT_MANIFEST)));
    assert.throws(() => promoteAuthenticatedBatch(batch, w.corpus, 10), /WATCH_EXPORT_MANIFEST_INVALID/);
    assert.throws(() => promoteCandidateSegment(batch, w.candidates, { paymentHeight: TIP, paymentTxid: tx("3"), paymentConfirmations: N }), /CANDIDATE_SEGMENT_MANIFEST_INVALID/);
    assert.throws(() => promoteCandidateSegment(batch, w.candidates, { paymentHeight: TIP + 1, paymentTxid: tx("2"), paymentConfirmations: N }), /CANDIDATE_SEGMENT_MANIFEST_INVALID/);
    assert.deepEqual(readdirSync(w.corpus), []);
    assert.deepEqual(promoteCandidateSegment(batch, w.candidates, { paymentHeight: TIP, paymentTxid: tx("2"), paymentConfirmations: N }), { startHeight: TIP, endHeight: TIP + 19 });
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("real verify-block: proof of work, Merkle root and exact txid on a mainnet block", () => {
  const binary = join("services", "zcash-watch", "target", "debug", `zecone-zcash-watch${process.platform === "win32" ? ".exe" : ""}`);
  assert.ok(existsSync(binary), "build services/zcash-watch first");
  const fixture = readFileSync("services/zcash-watch/tests/fixtures/mainnet-block-3526379.bin");
  const hash = "0000000000262d7bf2e92055df778b830f37cc92bdab7aac722b09001a0aeb48";
  const dir = mkdtempSync(join(tmpdir(), "zecone-verify-block-"));
  try {
    const good = join(dir, "good.bin");
    writeFileSync(good, fixture);
    const v = rustVerifyBlock(binary, good, hash, 3526379);
    assert.equal(v.proofOfWork, "PASS");
    assert.equal(v.transactionMerkleRootMatchesHeader, true);
    assert.match(v.previousBlockHash, /^[0-9a-f]{64}$/);
    assert.match(v.target, /^[0-9a-f]{64}$/);
    // A txid that is not in the block is rejected (the Rust check also rejects duplicates).
    assert.throws(() => rustVerifyBlock(binary, good, hash, 3526379, "0".repeat(64)));
    // Wrong height or hash.
    assert.throws(() => rustVerifyBlock(binary, good, hash, 3526380));
    assert.throws(() => rustVerifyBlock(binary, good, "1".repeat(64), 3526379));
    // One flipped byte in the Equihash solution, and one in a transaction (Merkle root).
    for (const offset of [200, fixture.length - 40]) {
      const bad = Buffer.from(fixture);
      bad[offset] ^= 0xff;
      const file = join(dir, `bad-${offset}.bin`);
      writeFileSync(file, bad);
      assert.throws(() => rustVerifyBlock(binary, file, hash, 3526379));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    assert.equal(noteCount(t.h), 0);
    assert.equal(t.h.app.bridge!.health().tip, tipBefore);
    assert.equal(t.h.app.bridge!.health().ready, false);
    assert.deepEqual(t.w.exported, []);
  } finally {
    await t.close();
  }
});

test("candidate bytes are fully verified by the scan before any observation", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(N);
    const H = TIP + 1;
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: H, zatoshis: "2000000", address: ADDR }));
    // Tampered bytes already sitting in the candidate directory are not trusted.
    writeFileSync(join(t.w.candidates, `${H}-${blockHash(t.w.chain, H)}.bin`), "forged block bytes");
    const r = await t.h.app.bridge!.tick();
    assert.equal(r.ok, false);
    assert.equal(r.error, "mainnet_watch_scan_failed");
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    rmSync(join(t.w.candidates, `${H}-${blockHash(t.w.chain, H)}.bin`));
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    const cur = await state(t.h, key, payment.id);
    assert.equal(cur.state, "ZEC_CONFIRMED");
    assert.equal(cur.chainEvidence.confirmations, N);
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
    assert.equal((await t.h.app.bridge!.tick()).ok, false);
    assert.deepEqual(t.w.exported, []);
    // A candidate txid the served payment block does not contain: export refused.
    t.w.update((c) => {
      c.notes = [{ txid: tx("8"), height: TIP + 2, zatoshis: "2000000", address: ADDR }];
      c.omitTxids = [TIP + 2];
    });
    assert.equal((await t.h.app.bridge!.tick()).error, "WATCH_CANDIDATE_EXPORT_FAILED");
    // In a block, but full-transaction UFVK decryption does not yield our note.
    t.w.update((c) => {
      c.omitTxids = [];
      c.notes = [{ txid: tx("8"), height: TIP + 2, zatoshis: "2000000", address: ADDR, failAfterSegment: "mainnet_owned_note_decryption_failed" }];
    });
    assert.equal((await t.h.app.bridge!.tick()).ok, false);
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    assert.equal(noteCount(t.h), 0);
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
    t.w.mine(N);
    t.w.update((c) => c.notes.push({ txid: tx("4"), height: TIP + 1, zatoshis: "1999999", address: ADDR }));
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    assert.equal((await state(t.h, key, payment.id)).state, "MANUAL_REVIEW");
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
    // Mined after the inclusion height (and after the first note's exported segment,
    // since a mined block never gains transactions): late deposit, manual review.
    const expiry = (await state(t.h, key, payment.id)).paymentExpiryHeight as number;
    const late = Math.max(expiry + 1, TIP + N);
    t.w.mine(late + N - 1 - t.w.chain.tip);
    t.w.update((c) => c.notes.push({ txid: tx("6"), height: late, zatoshis: "2000000", address: ADDR }));
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    assert.equal((await state(t.h, key, payment.id)).state, "MANUAL_REVIEW");
  } finally {
    await t.close();
  }
});

test("provider disagreement fails closed, during discovery and during segment export", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(N);
    t.w.update((c) => {
      c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR });
      c.fail = "mainnet_provider_disagreement";
    });
    assert.equal((await t.h.app.bridge!.tick()).ok, false);
    assert.deepEqual(t.w.exported, []);
    for (const fault of [{ rawDisagree: [TIP + 7] }, { providerDisagree: [TIP + 12] }, { rawMissing: [TIP + 3] }]) {
      t.w.update((c) => {
        delete c.fail;
        delete c.rawDisagree;
        delete c.providerDisagree;
        delete c.rawMissing;
        Object.assign(c, fault);
      });
      const r = await t.h.app.bridge!.tick();
      assert.equal(r.error, "WATCH_CANDIDATE_EXPORT_FAILED", JSON.stringify(fault));
      // A failed batch is never promoted: no partial segment, staging cleaned.
      assert.deepEqual(readdirSync(t.w.candidates), []);
      assert.deepEqual(readdirSync(join(t.w.state, "watch-worker", "candidate-staging")), []);
    }
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    assert.ok(t.unchanged());
  } finally {
    await t.close();
  }
});

test("fewer than 20 confirmations never confirms, even when raw blocks already exist", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(5);
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    for (let h = TIP + 1; h <= TIP + 5; h++) t.w.seedCorpus(h); // a caught-up corpus
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    const cur = await state(t.h, key, payment.id);
    assert.equal(cur.state, "VERIFYING");
    assert.equal(cur.confirmations, 5);
  } finally {
    await t.close();
  }
});

test("a reorganization invalidates a pending candidate, an in-flight export and a verified payment", async () => {
  // Pending at 15 confirmations, then reorganized away: never exported or attributed.
  let t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(15);
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    assert.equal((await t.h.app.bridge!.tick()).error, CANDIDATE_PENDING);
    t.w.update((c) => {
      c.notes = [];
      for (let h = TIP + 1; h <= c.tip; h++) c.hashes[h] = (h.toString(16) + "cd").padStart(64, "0");
    });
    t.w.mine(10);
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
    assert.deepEqual(t.w.exported, []);
  } finally {
    await t.close();
  }
  // A block in the segment changes during the targeted export: nothing promoted.
  t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(N);
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    const w = t.w;
    w.onProbe((_h, count) => {
      if (count === N + 2) w.update((c) => (c.hashes[TIP + 9] = "9".repeat(64)));
    });
    assert.equal((await t.h.app.bridge!.tick()).error, "WATCH_CANDIDATE_EXPORT_FAILED");
    assert.deepEqual(readdirSync(t.w.candidates), []);
    assert.equal((await state(t.h, key, payment.id)).state, "AWAITING_PAYMENT");
  } finally {
    await t.close();
  }
  // A verified payment whose block changes after targeted export goes to manual review.
  t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(N);
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    assert.equal((await state(t.h, key, payment.id)).state, "ZEC_CONFIRMED");
    t.w.update((c) => {
      for (let h = TIP + 1; h <= c.tip; h++) c.hashes[h] = (h.toString(16) + "ef").padStart(64, "0");
    });
    // The re-mined note's new segment is fetched and verified; the changed block
    // sends the confirmed order to manual review.
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    assert.equal((await state(t.h, key, payment.id)).state, "MANUAL_REVIEW");
  } finally {
    await t.close();
  }
});

test("replayed and duplicate observations are rejected", async () => {
  const t = await setup();
  try {
    const { key, payment } = await openOrder(t.h);
    t.w.mine(N);
    t.w.update((c) => c.notes.push({ txid: tx("2"), height: TIP + 1, zatoshis: "2000000", address: ADDR }));
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    // Re-observing the same verified note neither re-attributes nor re-exports.
    const exported = t.w.exported.length;
    assert.equal((await t.h.app.bridge!.tick()).ok, true);
    assert.equal(t.w.exported.length, exported);
    assert.equal(noteCount(t.h), 1);
    assert.equal((await state(t.h, key, payment.id)).state, "ZEC_CONFIRMED");
    // A note can never be both verified and pending, or pending twice.
    const s = structuredClone(await t.w.scanner(true).observe()) as MainnetWatchSnapshot;
    const p = s.payments[0];
    const pending = {
      account: p.account, txid: p.txid, pool: p.pool, index: p.index, zatoshis: p.zatoshis, height: p.height,
      blockHash: p.blockHash, address: p.address, isChange: false as const, confirmations: p.confirmations,
      verified: false as const, evidence: "compact-scan-candidate" as const, missingHeight: p.height, missingHash: p.blockHash,
      segmentEnd: p.height + N - 1,
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
      // (Its segment ends before the real payment's block, which is mined later.)
      c.notes.push({ txid: tx("b"), height: TIP - 25, zatoshis: "2000000", address: ADDR });
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

test("a checkout completes inside the unchanged observation grace period", () => {
  // Expected chain time to a height = blocks past the allocation tip at 75 s,
  // less the tip's age. Worst case: paid at the last allowed height.
  const now = 1_800_000_000;
  let checked = 0;
  for (const windowSeconds of [60, 300]) {
    for (let tipAge = 0; tipAge <= 1200; tipAge += 75) {
      let w;
      try {
        w = paymentWindow({ now, paymentDeadline: now + windowSeconds, tip: 1000, tipObservedAt: now - tipAge, observationGraceSeconds: DEFAULT_OBSERVATION_GRACE_SECONDS });
      } catch {
        continue; // allocation refused: the inclusion bound would exceed MAX_INCLUSION_BLOCKS
      }
      checked++;
      assert.ok(w.paymentExpiryHeight - 1000 <= MAX_INCLUSION_BLOCKS);
      const secondsUntil = (height: number) => (height - 1000) * ZCASH_TARGET_SPACING_SECONDS - tipAge;
      const verifiedAt = secondsUntil(w.paymentExpiryHeight + N - 1); // exactly 20 confirmations
      const budget = w.observationDeadline - now;
      assert.ok(verifiedAt <= budget, `window ${windowSeconds}s tip age ${tipAge}s: ${verifiedAt}s > ${budget}s`);
      // At least the 10 blocks (750 s) of margin that the previous 30-block wait consumed.
      assert.ok(budget - verifiedAt >= 10 * ZCASH_TARGET_SPACING_SECONDS);
    }
  }
  assert.ok(checked > 10);
});

test("the targeted path has no signing, broadcast, payout or settlement capability", () => {
  const files = [
    "services/payments/targeted-observation.ts",
    "services/operations/candidate-segment-export.ts",
    "scripts/mainnet-candidate-segment-export.ts",
    "tests/helpers/fake-targeted-watcher.ts",
  ];
  for (const f of files) {
    const source = readFileSync(f, "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const i of imports)
      assert.doesNotMatch(i, /sign|submit|broadcast|relayer|executor|solana|base\.ts|keystore|payout|spend|wallet/i, `${f}: ${i}`);
    assert.doesNotMatch(source, /sendRawTransaction|broadcast\(|\bsign\(|privateKey|mnemonic/, f);
  }
  // The only watcher commands the candidate exporter may run are read-only.
  const script = readFileSync("scripts/mainnet-candidate-segment-export.ts", "utf8");
  const commands = [...script.matchAll(/"\.unused",\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(commands)].sort(), ["probe-mainnet", "verify-block"]);
  assert.match(readFileSync("services/payments/targeted-observation.ts", "utf8"), /scripts\/mainnet-candidate-segment-export\.ts/);
  assert.match(readFileSync("services/zcash-watch/src/main.rs", "utf8"), /if sources\.defer_missing_segments \{\n\s+snapshot\["pendingCandidates"\]/);
});
