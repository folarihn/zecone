// Fast, order-scoped Zcash payment observation: discovery, then targeted verification.
//
// Discovery is the existing incremental compact-block UFVK scan. With
// `--defer-missing-segments` the Rust watcher lists an owned note whose raw
// confirmation segment is not authenticated yet as a pending candidate instead
// of failing the whole scan. A candidate is never proof of payment.
//
// Verification: for a checkout-address candidate at height H, once it has the
// payment confirmation policy N (tip >= H+N-1; payment confirmations are
// tip - height + 1), exactly the N-block segment H..H+N-1 is exported by the
// candidate-segment exporter (services/operations/candidate-segment-export.ts:
// lightwalletd agreement on every block, identical raw bytes from two operators,
// local hash/PoW/Merkle checks, the payment txid exactly once, continuity, no
// block above the agreed tip, and a re-probe that fails on any chain change) into
// a SEPARATE candidate-blocks directory. The scan then runs again and the Rust
// watcher applies its full checks to those bytes: two-provider transaction bytes,
// compact-block membership, PoW/Merkle/continuity/accumulated work, and fresh
// UFVK trial decryption with exact receiver, amount, pool and output index.
// Before N confirmations, or while a candidate stays unverified, the cycle fails
// closed: the bridge records nothing and no heartbeat is sent.
//
// The historical exporter (scripts/mainnet-block-export.ts) and its 10-block
// finality floor are not used here and are unchanged. The historical corpus and
// the watch-worker checkpoint are never written here.
//
// Candidates in an order's (allocationTip, paymentExpiryHeight] window go first.
// Other checkout-address candidates (late or unsolicited deposits) are verified
// too, so attribution can record them for manual review rather than letting one
// block the watcher until the historical backlog reaches it. No signing,
// spending key, broadcast or payout code is reachable from this module.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  MainnetPendingCandidate,
  MainnetWatchSnapshot,
} from "../settlement/mainnet-watch.ts";
import {
  promoteCandidateSegment,
  validateCandidateSegmentRequest,
  type CandidateSegmentRequest,
} from "../operations/candidate-segment-export.ts";
import type { PaymentStore } from "./store.ts";

export interface OrderWindow {
  paymentId: string;
  /** The watcher tip when the address was allocated; a payment must be mined above it. */
  allocationHeight: number;
  expiryHeight: number;
  recipient: string;
  expectedZatoshis: string;
}

export interface PaymentCandidate {
  /** The single order whose window contains the candidate, if any. */
  paymentId: string | null;
  allocationHeight: number | null;
  expiryHeight: number | null;
  expectedZatoshis: string | null;
  inWindow: boolean;
  recipient: string;
  txid: string;
  height: number;
  blockHash: string;
  pool: 2 | 3 | 4;
  index: number;
  zatoshis: string;
  /** Payment confirmations at the scanned tip (tip - height + 1). */
  confirmations: number;
  missingHeight: number;
  segmentEnd: number;
}

export type SegmentRequest = Omit<CandidateSegmentRequest, "output">;

interface Source {
  observe(checkpointHeight?: number): Promise<MainnetWatchSnapshot>;
}

export const CANDIDATE_PENDING = "WATCH_CANDIDATE_VERIFICATION_PENDING";

/** Real orders allocated to the checkout address with a bounded inclusion window. */
export function orderWindows(store: PaymentStore, receivingAddress: string): OrderWindow[] {
  const rows = store.db
    .prepare(
      `SELECT id FROM payments WHERE mode='monitor' AND zcash_address=?
         AND allocation_tip IS NOT NULL AND payment_expiry_height IS NOT NULL`,
    )
    .all(receivingAddress) as { id: string }[];
  const windows: OrderWindow[] = [];
  for (const { id } of rows) {
    const p = store.getPayment(id);
    if (!p?.quote || p.allocationTip === null || p.paymentExpiryHeight === null) continue;
    windows.push({
      paymentId: p.id,
      allocationHeight: p.allocationTip,
      expiryHeight: p.paymentExpiryHeight,
      recipient: receivingAddress,
      expectedZatoshis: p.quote.zecAmountZat,
    });
  }
  return windows;
}

/** Checkout-address candidates, each bound to the order window that contains it. */
export function scopeCandidates(
  snapshot: MainnetWatchSnapshot,
  windows: OrderWindow[],
  receivingAddress: string,
): PaymentCandidate[] {
  const out: PaymentCandidate[] = [];
  for (const c of snapshot.pendingCandidates ?? []) {
    if (c.isChange || c.address !== receivingAddress) continue;
    const matches = windows.filter(
      (w) => w.recipient === c.address && c.height > w.allocationHeight && c.height <= w.expiryHeight,
    );
    // Exclusive allocation gives at most one window; anything else stays unbound.
    const w = matches.length === 1 ? matches[0] : null;
    out.push(candidate(c, w, matches.length > 0));
  }
  return out.sort((a, b) => Number(b.inWindow) - Number(a.inWindow) || a.height - b.height);
}

function candidate(c: MainnetPendingCandidate, w: OrderWindow | null, inWindow: boolean): PaymentCandidate {
  return {
    paymentId: w?.paymentId ?? null,
    allocationHeight: w?.allocationHeight ?? null,
    expiryHeight: w?.expiryHeight ?? null,
    expectedZatoshis: w?.expectedZatoshis ?? null,
    inWindow,
    recipient: c.address,
    txid: c.txid,
    height: c.height,
    blockHash: c.blockHash,
    pool: c.pool,
    index: c.index,
    zatoshis: c.zatoshis,
    confirmations: c.confirmations,
    missingHeight: c.missingHeight,
    segmentEnd: c.segmentEnd,
  };
}

/**
 * The candidate-segment request for a candidate, or null while it has fewer
 * than `paymentConfirmations` payment confirmations. At exactly N the segment
 * H..H+N-1 ends at the scanned tip.
 */
export function segmentRequest(
  c: Pick<PaymentCandidate, "height" | "txid" | "confirmations" | "segmentEnd">,
  paymentConfirmations: number,
): SegmentRequest | null {
  if (c.confirmations < paymentConfirmations) return null;
  if (c.segmentEnd !== c.height + paymentConfirmations - 1) return null;
  return { paymentHeight: c.height, paymentTxid: c.txid, paymentConfirmations };
}

export class TargetedObservationSource implements Source {
  /** Candidates from the latest scan, for operator status only. */
  lastCandidates: PaymentCandidate[] = [];

  constructor(
    private readonly scanner: Source,
    private readonly opts: {
      receivingAddress: string;
      /** The payment confirmation policy (the watcher's minimum confirmations). */
      paymentConfirmations: number;
      windows(): OrderWindow[];
      exportSegment(request: SegmentRequest): Promise<void>;
      maxSegmentsPerCycle?: number;
    },
  ) {}

  async observe(checkpointHeight?: number): Promise<MainnetWatchSnapshot> {
    const first = await this.scanner.observe(checkpointHeight);
    let candidates = this.scope(first);
    if (candidates.length === 0) return first;
    let segments = 0;
    for (const c of candidates) {
      if (segments >= (this.opts.maxSegmentsPerCycle ?? 4)) break;
      const request = segmentRequest(c, this.opts.paymentConfirmations);
      if (!request) continue;
      await this.opts.exportSegment(request);
      segments++;
    }
    if (segments === 0) throw Error(CANDIDATE_PENDING);
    const second = await this.scanner.observe(checkpointHeight);
    candidates = this.scope(second);
    if (candidates.length > 0) throw Error(CANDIDATE_PENDING);
    return second;
  }

  private scope(s: MainnetWatchSnapshot) {
    this.lastCandidates = scopeCandidates(s, this.opts.windows(), this.opts.receivingAddress);
    return this.lastCandidates;
  }
}

export type SegmentRunner = (args: CandidateSegmentRequest & { publicProbeConfig: string }) => Promise<void>;

const execFileAsync = promisify(execFile);
const EXPORTER = fileURLToPath(new URL("../../scripts/mainnet-candidate-segment-export.ts", import.meta.url));

/** The candidate-segment exporter process (never the historical exporter). */
export const runCandidateSegmentExporter: SegmentRunner = async (a) => {
  await execFileAsync(
    process.execPath,
    [
      "--experimental-transform-types",
      EXPORTER,
      "--config",
      resolve(a.publicProbeConfig),
      "--output",
      a.output,
      "--payment-height",
      String(a.paymentHeight),
      "--payment-txid",
      a.paymentTxid,
      "--payment-confirmations",
      String(a.paymentConfirmations),
    ],
    { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
};

/**
 * Export one payment's segment into the candidate-blocks directory. The batch is
 * staged, its candidate manifest is rechecked against the request and every
 * block's bytes, and only then are blocks added. The historical corpus
 * `watch-worker/authenticated-blocks` is never touched.
 */
export function candidateSegmentExporter(opts: {
  stateDirectory: string;
  publicProbeConfig: string;
  run?: SegmentRunner;
}) {
  const root = join(resolve(opts.stateDirectory), "watch-worker");
  const directory = join(root, "candidate-blocks");
  const staging = join(root, "candidate-staging");
  return {
    directory,
    async exportSegment(request: SegmentRequest) {
      try {
        validateCandidateSegmentRequest({ ...request, output: "" });
      } catch {
        throw Error("WATCH_CANDIDATE_SEGMENT_INVALID");
      }
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const batch = join(staging, `${request.paymentHeight}-${request.paymentTxid.slice(0, 16)}-${process.pid}-${randomUUID()}`);
      try {
        try {
          await (opts.run ?? runCandidateSegmentExporter)({ ...request, output: batch, publicProbeConfig: opts.publicProbeConfig });
        } catch {
          throw Error("WATCH_CANDIDATE_EXPORT_FAILED");
        }
        promoteCandidateSegment(batch, directory, request);
      } finally {
        rmSync(batch, { recursive: true, force: true });
      }
    },
  };
}
