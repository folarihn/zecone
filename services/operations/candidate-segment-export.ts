// Candidate-segment export: the raw blocks that prove ONE detected payment, at
// exactly the payment confirmation policy, for targeted observation only.
//
// This is a separate policy from the historical exporter
// (scripts/mainnet-block-export.ts), whose 10-block finality floor for permanent
// corpus promotion is unchanged. A candidate segment is the payment block H and
// the next N-1 blocks, where N is the payment confirmation policy (>= 20):
// exported only once H has N payment confirmations (tip >= H+N-1), never earlier,
// and never past the providers' agreed tip. Its manifest has its own file name
// and mode, so the historical promotion path cannot accept it, and it is only
// ever promoted into the isolated candidate-blocks directory.
//
// Semantics: `probe-mainnet` reports depth as `tip - height`; payment
// confirmations are `tip - height + 1`.
//
// Every block must pass, in order:
//   - both lightwalletd providers agree on its hash (probe-mainnet),
//   - both raw-block operators return identical bytes,
//   - local verification of the header hash, Equihash proof of work and the
//     transaction Merkle root (and, for H, the payment txid exactly once),
//   - continuity: its header's previous hash is the agreed hash of the prior block.
// Afterwards every height is probed again: a changed hash or a tip below the
// segment end fails closed. Nothing here signs, spends or broadcasts.
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEX64 = /^[0-9a-f]{64}$/i;
export const CANDIDATE_SEGMENT_MANIFEST = "candidate-segment-manifest.json";
export const CANDIDATE_SEGMENT_MODE = "CANDIDATE_SEGMENT";

export interface SegmentProbe {
  height: number;
  blockHash: string;
  /** probe-mainnet depth: agreed tip minus height. */
  confirmations: number;
  providerAgreement: string;
}

export interface VerifiedRawBlock {
  proofOfWork: string;
  transactionMerkleRootMatchesHeader: boolean;
  transactionIdMatched: boolean;
  previousBlockHash: string;
  target: string;
}

export interface CandidateSegmentDeps {
  probe(height: number): Promise<SegmentProbe>;
  fetchRaw(hash: string): Promise<{ bytes: Uint8Array; sha256: string; operators: string[] }>;
  verifyBlock(file: string, hash: string, height: number, txid?: string): Promise<VerifiedRawBlock>;
}

export interface CandidateSegmentRequest {
  paymentHeight: number;
  paymentTxid: string;
  /** The payment confirmation policy N (the watcher's minimum confirmations). */
  paymentConfirmations: number;
  output: string;
}

export interface CandidateSegmentManifest {
  schemaVersion: 1;
  network: "zcash-mainnet";
  mode: typeof CANDIDATE_SEGMENT_MODE;
  executionAllowed: false;
  paymentHeight: number;
  paymentTxid: string;
  paymentConfirmations: number;
  startHeight: number;
  endHeight: number;
  agreedTip: number;
  chainContinuity: "PASS";
  accumulatedWork: string;
  blocks: { height: number; hash: string; sha256: string; bytes: number; rawBlockOperators: string[] }[];
}

const fail = (code: string): never => {
  throw Error(code);
};

function writeNew(path: string, data: Uint8Array | string) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function validateCandidateSegmentRequest(r: CandidateSegmentRequest) {
  if (
    !Number.isSafeInteger(r.paymentHeight) ||
    r.paymentHeight < 1 ||
    !HEX64.test(r.paymentTxid) ||
    !Number.isSafeInteger(r.paymentConfirmations) ||
    r.paymentConfirmations < 20 ||
    r.paymentConfirmations > 99
  )
    fail("CANDIDATE_SEGMENT_REQUEST_INVALID");
}

/** Export and verify the N-block segment of one payment into a NEW directory. */
export async function exportCandidateSegment(
  deps: CandidateSegmentDeps,
  request: CandidateSegmentRequest,
): Promise<CandidateSegmentManifest> {
  validateCandidateSegmentRequest(request);
  const { paymentHeight: start, paymentConfirmations: n, output } = request;
  const txid = request.paymentTxid.toLowerCase();
  const end = start + n - 1;
  if (existsSync(output)) fail("CANDIDATE_SEGMENT_OUTPUT_EXISTS");
  const agreed = async (height: number) => {
    const p = await deps.probe(height);
    if (p.providerAgreement !== "PASS" || p.height !== height || !HEX64.test(p.blockHash) || !Number.isSafeInteger(p.confirmations) || p.confirmations < 0)
      fail("CANDIDATE_SEGMENT_PROVIDER_DISAGREEMENT");
    return { hash: p.blockHash.toLowerCase(), tip: height + p.confirmations };
  };
  mkdirSync(output, { mode: 0o700 });
  try {
    const first = await agreed(start);
    // Payment confirmations = depth + 1. Fewer than N: the candidate stays pending.
    if (first.tip - start + 1 < n) fail("CANDIDATE_SEGMENT_INSUFFICIENT_CONFIRMATIONS");
    if (end > first.tip) fail("CANDIDATE_SEGMENT_ABOVE_TIP");
    const blocks: CandidateSegmentManifest["blocks"] = [];
    let prior: string | undefined;
    let work = 0n;
    for (let height = start; height <= end; height++) {
      const { hash, tip } = height === start ? first : await agreed(height);
      if (tip < end) fail("CANDIDATE_SEGMENT_TIP_CHANGED");
      const raw = await deps.fetchRaw(hash);
      if (createHash("sha256").update(raw.bytes).digest("hex") !== raw.sha256) fail("CANDIDATE_SEGMENT_RAW_BLOCK_INVALID");
      const temporary = join(output, `.${height}-${hash}.partial`);
      writeNew(temporary, raw.bytes);
      const v = await deps.verifyBlock(temporary, hash, height, height === start ? txid : undefined);
      if (v.proofOfWork !== "PASS" || v.transactionMerkleRootMatchesHeader !== true) fail("CANDIDATE_SEGMENT_BLOCK_VERIFICATION_FAILED");
      if (height === start && v.transactionIdMatched !== true) fail("CANDIDATE_SEGMENT_TRANSACTION_NOT_IN_BLOCK");
      if (prior !== undefined && String(v.previousBlockHash).toLowerCase() !== prior) fail("CANDIDATE_SEGMENT_DISCONTINUITY");
      if (!HEX64.test(String(v.target)) || BigInt(`0x${v.target}`) === 0n) fail("CANDIDATE_SEGMENT_TARGET_INVALID");
      work += (1n << 256n) / (BigInt(`0x${v.target}`) + 1n);
      renameSync(temporary, join(output, `${height}-${hash}.bin`));
      blocks.push({ height, hash, sha256: raw.sha256, bytes: raw.bytes.length, rawBlockOperators: raw.operators });
      prior = hash;
    }
    // The chain must not have moved under the export: same hashes, tip still covers it.
    for (const b of blocks) {
      const again = await agreed(b.height);
      if (again.hash !== b.hash) fail("CANDIDATE_SEGMENT_CHAIN_CHANGED");
      if (again.tip < end) fail("CANDIDATE_SEGMENT_TIP_CHANGED");
    }
    const manifest: CandidateSegmentManifest = {
      schemaVersion: 1,
      network: "zcash-mainnet",
      mode: CANDIDATE_SEGMENT_MODE,
      executionAllowed: false,
      paymentHeight: start,
      paymentTxid: txid,
      paymentConfirmations: n,
      startHeight: start,
      endHeight: end,
      agreedTip: first.tip,
      chainContinuity: "PASS",
      accumulatedWork: work.toString(16),
      blocks,
    };
    writeNew(join(output, CANDIDATE_SEGMENT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Promote a verified candidate segment into the candidate-blocks directory only.
 * Rechecks the manifest against the request and every block's bytes; an existing
 * file of the same name must have identical bytes.
 */
export function promoteCandidateSegment(batch: string, directory: string, expected: Omit<CandidateSegmentRequest, "output">) {
  let m: CandidateSegmentManifest;
  try {
    m = JSON.parse(readFileSync(join(batch, CANDIDATE_SEGMENT_MANIFEST), "utf8"));
  } catch {
    return fail("CANDIDATE_SEGMENT_MANIFEST_INVALID");
  }
  const end = expected.paymentHeight + expected.paymentConfirmations - 1;
  if (
    m.network !== "zcash-mainnet" ||
    m.mode !== CANDIDATE_SEGMENT_MODE ||
    m.chainContinuity !== "PASS" ||
    m.paymentHeight !== expected.paymentHeight ||
    m.paymentTxid !== expected.paymentTxid.toLowerCase() ||
    m.paymentConfirmations !== expected.paymentConfirmations ||
    m.startHeight !== expected.paymentHeight ||
    m.endHeight !== end ||
    !Number.isSafeInteger(m.agreedTip) ||
    m.agreedTip < end ||
    !Array.isArray(m.blocks) ||
    m.blocks.length !== expected.paymentConfirmations
  )
    fail("CANDIDATE_SEGMENT_MANIFEST_INVALID");
  const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  for (const [i, b] of m.blocks.entries())
    if (b.height !== m.startHeight + i || !HEX64.test(b.hash) || !HEX64.test(b.sha256)) fail("CANDIDATE_SEGMENT_MANIFEST_INVALID");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const b of m.blocks) {
    const name = `${b.height}-${b.hash}.bin`;
    const source = join(batch, name);
    const target = join(directory, name);
    if (!existsSync(source) || sha(source) !== b.sha256) fail("CANDIDATE_SEGMENT_BLOCK_INVALID");
    if (existsSync(target)) {
      if (sha(target) !== b.sha256) fail("CANDIDATE_SEGMENT_CONFLICT");
    } else copyFileSync(source, target, 0);
  }
  return { startHeight: m.startHeight, endHeight: m.endHeight };
}
