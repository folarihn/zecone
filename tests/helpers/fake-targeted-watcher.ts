// Stand-ins for targeted observation tests. The fake `observe-mainnet` models the
// Rust watcher's raw-block rule: a note is a verified payment only when every
// block of its confirmation segment exists as `height-hash.bin` (corpus first,
// then the candidate directory) with bytes that verify; with
// `--defer-missing-segments` a missing block makes it a pending candidate,
// otherwise the scan fails. Segments are exported by the REAL
// exportCandidateSegment policy over fake providers: lightwalletd probes, two
// raw-block operators and local block verification (hash, PoW flag, previous
// hash, txids). Synthetic only: no network, keys, signing or broadcast.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainnetWatchScanner } from "../../services/settlement/mainnet-watch.ts";
import type { SegmentRunner } from "../../services/payments/targeted-observation.ts";
import { exportCandidateSegment, type CandidateSegmentDeps } from "../../services/operations/candidate-segment-export.ts";

export const SOURCE = "https://light.example.org";
export const PEER = "https://peer.example.org";

export type TargetedNote = {
  txid: string;
  height: number;
  zatoshis: string;
  address: string;
  index?: number;
  pool?: 2 | 3 | 4;
  /** Rust failure before the segment is read (provider/transaction disagreement). */
  failBeforeSegment?: string;
  /** Rust failure after the segment verifies (e.g. UFVK decryption of a forged note). */
  failAfterSegment?: string;
};

export type TargetedChain = {
  tip: number;
  hashes: Record<number, string>;
  notes: TargetedNote[];
  defaultAddress: string;
  fail?: string;
  /** Heights whose lightwalletd providers disagree. */
  providerDisagree?: number[];
  /** Heights whose raw block the two raw-block operators disagree on. */
  rawDisagree?: number[];
  /** Heights no raw-block operator can serve. */
  rawMissing?: number[];
  /** Heights whose served raw block fails proof of work. */
  badPow?: number[];
  /** Heights whose served raw block names a different previous hash. */
  brokenPrev?: number[];
  /** Extra txids in a block (e.g. a duplicate of the payment txid). */
  extraTxids?: Record<number, string[]>;
  /** Heights whose served block omits its notes' txids. */
  omitTxids?: number[];
};

export const blockHash = (chain: Pick<TargetedChain, "hashes">, h: number) =>
  chain.hashes[h] ?? (h.toString(16) + "ab").padStart(64, "0");

/** Canonical synthetic block bytes: what an honest raw-block operator serves. */
export function blockBytes(chain: TargetedChain, h: number) {
  return JSON.stringify({
    h,
    hash: blockHash(chain, h),
    prev: chain.brokenPrev?.includes(h) ? "e".repeat(64) : blockHash(chain, h - 1),
    pow: !chain.badPow?.includes(h),
    txids: chain.omitTxids?.includes(h)
      ? []
      : [...chain.notes.filter((n) => n.height === h).map((n) => n.txid), ...(chain.extraTxids?.[h] ?? [])],
  });
}

const SCRIPT = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const argv = process.argv.slice(2);
const chain = JSON.parse(fs.readFileSync(argv[0], "utf8"));
const logFile = argv[1];
const rest = argv.slice(2);
const arg = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
fs.appendFileSync(logFile, JSON.stringify({ observe: true, tip: chain.tip }) + "\n");
const fail = (code) => { process.stderr.write(code); process.exit(1); };
if (chain.fail) fail(chain.fail);
const minConf = Number(arg("--minimum-confirmations"));
const cpArg = arg("--checkpoint-height");
const tip = chain.tip;
if (cpArg !== undefined && Number(cpArg) > tip) fail("checkpoint_above_tip");
const hash = (h) => chain.hashes[h] || (h.toString(16) + "ab").padStart(64, "0");
const dirs = [arg("--authenticated-block-dir"), arg("--candidate-block-dir")].filter(Boolean);
const defer = rest.includes("--defer-missing-segments");
// Rust re-verifies every block it reads: hash, PoW, continuity, payment txid once.
const verify = (file, h, txid) => {
  let b;
  try { b = JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail("mainnet_block_verification_failed"); }
  if (b.h !== h || b.hash !== hash(h) || b.pow !== true || b.prev !== hash(h - 1)) fail("mainnet_block_verification_failed");
  if (txid !== undefined && b.txids.filter((t) => t === txid).length !== 1) fail("transaction_not_in_block");
};
const payments = [], pending = [];
for (const n of chain.notes.filter((n) => n.height <= tip).sort((a, b) => a.height - b.height)) {
  if (n.failBeforeSegment) fail(n.failBeforeSegment);
  const conf = tip - n.height + 1, count = Math.min(conf, minConf), end = n.height + count - 1;
  let missing = null;
  for (let h = n.height; h <= end; h++) {
    const file = dirs.map((d) => path.join(d, h + "-" + hash(h) + ".bin")).find((f) => fs.existsSync(f));
    if (!file) { missing = h; break; }
    verify(file, h, h === n.height ? n.txid : undefined);
  }
  const base = { account: "a".repeat(64), txid: n.txid, pool: n.pool || 3, index: n.index || 0, zatoshis: n.zatoshis,
    height: n.height, blockHash: hash(n.height), address: n.address, isChange: false, confirmations: conf };
  if (missing !== null) {
    if (!defer) fail("authenticated_mainnet_block_unavailable");
    pending.push({ ...base, verified: false, evidence: "compact-scan-candidate", missingHeight: missing, missingHash: hash(missing), segmentEnd: end });
    continue;
  }
  if (n.failAfterSegment) fail(n.failAfterSegment);
  payments.push({ ...base, memo: null, nullifier: null, locked: false, spent: false,
    ownershipEvidence: {
      scheme: "zcash-full-transaction-ufvk-v3", digest: crypto.createHash("sha256").update(n.txid + (n.index || 0)).digest("hex"), providers: 2,
      blockEvidence: { scheme: "zcash-header-pow-merkle-v1", height: n.height, headerHash: hash(n.height), merkleRoot: "6".repeat(64), transactionIndex: 0, transactionCount: 1, proofOfWork: "PASS", readOnly: true },
      chainEvidence: { scheme: "zcash-pow-chain-segment-v1", startHeight: n.height, endHeight: end, startHash: hash(n.height), endHash: hash(end), blockCount: count, accumulatedWork: "1234abcd", proofOfWork: "PASS", continuity: "PASS", readOnly: true },
    } });
}
process.stdout.write(JSON.stringify({
  network: "zcash-mainnet", watchOnly: true, liveChain: true, liveRefundsEnabled: false,
  source: arg("--server"), peerSource: arg("--peer"), account: "a".repeat(64), address: chain.defaultAddress,
  birthday: 1, tip, scanned: tip, blockHash: hash(tip), observedAt: Math.floor(Date.now() / 1000),
  minimumConfirmations: minConf, anchor: "f".repeat(64), anchorHeight: tip - 10,
  checkpoint: cpArg === undefined ? null : { height: Number(cpArg), hash: hash(Number(cpArg)), orchardRoot: "f".repeat(64) },
  payments, ...(defer ? { pendingCandidates: pending } : {}),
}));
`;

export function fakeTargetedWatcher(initial: TargetedChain, minimumConfirmations = 20) {
  const dir = mkdtempSync(join(tmpdir(), "zecone-targeted-"));
  const state = join(dir, "state");
  const wallet = join(dir, "watch-profile");
  const corpus = join(state, "watch-worker", "authenticated-blocks");
  const candidates = join(state, "watch-worker", "candidate-blocks");
  mkdirSync(corpus, { recursive: true });
  mkdirSync(candidates, { recursive: true });
  mkdirSync(wallet, { recursive: true });
  const chainFile = join(dir, "chain.json");
  const logFile = join(dir, "observe.log");
  const script = join(dir, "observe.cjs");
  writeFileSync(script, SCRIPT);
  writeFileSync(logFile, "");
  let chain = structuredClone(initial);
  const write = () => writeFileSync(chainFile, JSON.stringify(chain));
  write();
  const policy = {
    network: "zcash" as const,
    enabled: true,
    providers: [
      { endpoint: SOURCE, operator: "primary" },
      { endpoint: PEER, operator: "secondary" },
    ],
    independenceAcknowledged: true,
    confirmations: minimumConfirmations,
  };
  const scanner = (targeted: boolean) =>
    new MainnetWatchScanner(
      wallet,
      SOURCE,
      PEER,
      policy,
      process.execPath,
      [script, chainFile, logFile],
      corpus,
      undefined,
      targeted ? candidates : undefined,
    );
  const probes: number[] = [];
  /** Optional hook run on each probe, e.g. to reorganize the chain mid-export. */
  let onProbe: ((height: number, count: number) => void) | undefined;
  const deps: CandidateSegmentDeps = {
    probe: async (height) => {
      probes.push(height);
      onProbe?.(height, probes.length);
      if (height > chain.tip) throw Error("height_above_tip");
      return {
        height,
        blockHash: blockHash(chain, height),
        confirmations: chain.tip - height,
        providerAgreement: chain.providerDisagree?.includes(height) ? "FAILED" : "PASS",
      };
    },
    fetchRaw: async (hash) => {
      const h = Number(Object.keys(chain.hashes).find((k) => chain.hashes[Number(k)] === hash) ?? parseInt(hash.slice(0, -2), 16));
      if (blockHash(chain, h) !== hash) throw Error("zcash_raw_block_unavailable");
      if (chain.rawDisagree?.includes(h)) throw Error("zcash_raw_block_provider_disagreement");
      if (chain.rawMissing?.includes(h)) throw Error("zcash_raw_block_unavailable");
      const bytes = Buffer.from(blockBytes(chain, h));
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), operators: ["raw-a", "raw-b"] };
    },
    // Mirrors `verify-block`: hash, PoW and (for the payment block) the txid exactly once.
    verifyBlock: async (file, hash, height, txid) => {
      const b = JSON.parse(readFileSync(file, "utf8"));
      if (b.h !== height || b.hash !== hash) throw Error("header_hash_disagreement");
      if (b.pow !== true) throw Error("insufficient_proof_of_work");
      if (txid !== undefined && b.txids.filter((t: string) => t === txid).length !== 1) throw Error("transaction_not_in_block");
      return {
        proofOfWork: "PASS",
        transactionMerkleRootMatchesHeader: true,
        transactionIdMatched: txid !== undefined,
        previousBlockHash: b.prev,
        target: "0".repeat(8) + "f".repeat(56),
      };
    },
  };
  const exported: number[] = [];
  const exportTips: number[] = [];
  const run: SegmentRunner = async (request) => {
    const manifest = await exportCandidateSegment(deps, request);
    exported.push(...manifest.blocks.map((b) => b.height));
    exportTips.push(chain.tip);
  };
  return {
    dir,
    state,
    corpus,
    candidates,
    scanner,
    deps,
    run,
    exported,
    exportTips,
    probes,
    observeCalls: () =>
      readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean).length,
    get chain() {
      return chain;
    },
    update(fn: (c: TargetedChain) => void) {
      fn(chain);
      write();
    },
    onProbe(fn: typeof onProbe) {
      onProbe = fn;
    },
    mine(blocks: number) {
      for (let i = 0; i < blocks; i++) chain.tip += 1;
      write();
    },
    /** Put an authenticated historical block into the corpus (as the worker would). */
    seedCorpus(h: number) {
      writeFileSync(join(corpus, `${h}-${blockHash(chain, h)}.bin`), blockBytes(chain, h));
    },
  };
}
