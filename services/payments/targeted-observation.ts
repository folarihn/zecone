// Fast, order-scoped Zcash payment observation: discovery, then targeted verification.
//
// Discovery is the existing incremental compact-block UFVK scan. With
// `--defer-missing-segments` the Rust watcher lists an owned note whose raw
// confirmation segment is not authenticated yet as a pending candidate instead
// of failing the whole scan. A candidate is never proof of payment.
//
// Verification: for checkout-address candidates only, the bounded segment
// [missingHeight, segmentEnd], never past the export-finality floor, is exported
// by the existing two-provider exporter (lightwalletd agreement, two raw-block
// operators, proof of work, Merkle root, continuity) into a SEPARATE
// candidate-segment directory. The scan then runs again and the Rust watcher
// applies its full checks: two-provider transaction bytes, compact-block
// membership, raw-block PoW/Merkle/continuity/accumulated work, and fresh UFVK
// trial decryption with exact receiver, amount, pool and output index. A
// checkout-address candidate that is still unverified fails the cycle closed:
// the bridge records nothing and no heartbeat is sent.
//
// Candidates in an order's (allocationTip, paymentExpiryHeight] window go first.
// Other checkout-address candidates (late or unsolicited deposits) are verified
// too, so attribution can record them for manual review rather than letting one
// block the watcher until the historical backlog reaches it.
//
// The historical corpus and the watch-worker checkpoint are never written here;
// the historical worker keeps catching up separately. No signing, spending key,
// broadcast or payout code is reachable from this module.
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
import { promoteAuthenticatedBatch } from "../operations/mainnet-watch-worker.ts";
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
  missingHeight: number;
  segmentEnd: number;
}

export interface SegmentPlan {
  startHeight: number;
  count: number;
}

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
    missingHeight: c.missingHeight,
    segmentEnd: c.segmentEnd,
  };
}

/**
 * The exportable part of a candidate's missing segment: blocks the exporter will
 * accept (at least `exportMinimumConfirmations` deep), never more than the segment.
 */
export function segmentPlan(
  c: Pick<PaymentCandidate, "missingHeight" | "segmentEnd">,
  tip: number,
  exportMinimumConfirmations: number,
): SegmentPlan | null {
  const end = Math.min(c.segmentEnd, tip - exportMinimumConfirmations);
  if (end < c.missingHeight) return null;
  return { startHeight: c.missingHeight, count: end - c.missingHeight + 1 };
}

export class TargetedObservationSource implements Source {
  /** Candidates from the latest scan, for operator status only. */
  lastCandidates: PaymentCandidate[] = [];

  constructor(
    private readonly scanner: Source,
    private readonly opts: {
      receivingAddress: string;
      exportMinimumConfirmations: number;
      windows(): OrderWindow[];
      exportSegment(startHeight: number, count: number): Promise<void>;
      maxSegmentsPerCycle?: number;
    },
  ) {}

  async observe(checkpointHeight?: number): Promise<MainnetWatchSnapshot> {
    const first = await this.scanner.observe(checkpointHeight);
    let candidates = this.scope(first);
    if (candidates.length === 0) return first;
    const exported = new Set<number>();
    let segments = 0;
    for (const c of candidates) {
      if (segments >= (this.opts.maxSegmentsPerCycle ?? 4)) break;
      const plan = segmentPlan(c, first.tip, this.opts.exportMinimumConfirmations);
      if (!plan) continue;
      // Skip heights another candidate's segment already brought in this cycle.
      let start = plan.startHeight;
      const end = plan.startHeight + plan.count - 1;
      while (start <= end && exported.has(start)) start++;
      if (start > end) continue;
      await this.opts.exportSegment(start, end - start + 1);
      for (let h = start; h <= end; h++) exported.add(h);
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

export type ExportRunner = (args: {
  startHeight: number;
  count: number;
  output: string;
  publicProbeConfig: string;
  minimumConfirmations: number;
}) => Promise<void>;

const execFileAsync = promisify(execFile);
const EXPORTER = fileURLToPath(new URL("../../scripts/mainnet-block-export.ts", import.meta.url));

/** The existing authenticated raw-block exporter, run as for the historical worker. */
export const runBlockExporter: ExportRunner = async (a) => {
  await execFileAsync(
    process.execPath,
    [
      "--experimental-transform-types",
      EXPORTER,
      "--config",
      resolve(a.publicProbeConfig),
      "--output",
      a.output,
      "--start-height",
      String(a.startHeight),
      "--count",
      String(a.count),
      "--minimum-confirmations",
      String(a.minimumConfirmations),
    ],
    { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
};

/**
 * Export one bounded segment into the candidate-segment directory. The batch is
 * staged, its manifest and block hashes are checked by the same promotion the
 * historical worker uses, and only then are blocks added. The historical
 * corpus `watch-worker/authenticated-blocks` is never touched.
 */
export function candidateSegmentExporter(opts: {
  stateDirectory: string;
  publicProbeConfig: string;
  exportMinimumConfirmations: number;
  run?: ExportRunner;
}) {
  const root = join(resolve(opts.stateDirectory), "watch-worker");
  const directory = join(root, "candidate-blocks");
  const staging = join(root, "candidate-staging");
  return {
    directory,
    async exportSegment(startHeight: number, count: number) {
      if (!Number.isSafeInteger(startHeight) || startHeight < 1 || !Number.isSafeInteger(count) || count < 1 || count > 100)
        throw Error("WATCH_CANDIDATE_SEGMENT_INVALID");
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const batch = join(staging, `${startHeight}-${startHeight + count - 1}-${process.pid}-${randomUUID()}`);
      try {
        try {
          await (opts.run ?? runBlockExporter)({
            startHeight,
            count,
            output: batch,
            publicProbeConfig: opts.publicProbeConfig,
            minimumConfirmations: opts.exportMinimumConfirmations,
          });
        } catch {
          throw Error("WATCH_CANDIDATE_EXPORT_FAILED");
        }
        const promoted = promoteAuthenticatedBatch(batch, directory, opts.exportMinimumConfirmations);
        if (promoted.startHeight !== startHeight || promoted.endHeight !== startHeight + count - 1)
          throw Error("WATCH_EXPORT_RANGE_MISMATCH");
      } finally {
        rmSync(batch, { recursive: true, force: true });
      }
    },
  };
}
