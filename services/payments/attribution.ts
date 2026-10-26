// Payment attribution for real (monitor-mode) shielded deposits.
//
// ZecOne attributes an incoming shielded Zcash note to a payment only when ALL hold:
//   1. the note was decrypted by the watch-only UFVK and its receiver equals the
//      receiving address (Rust watcher, `zcash-full-transaction-ufvk-v3` evidence
//      cross-checked against two independent providers);
//   2. exactly one payment held the EXCLUSIVE allocation of that address, was
//      still awaiting payment and unexpired;
//   3. the note was mined AFTER the allocation (note height > chain tip recorded
//      when the address was allocated) — older notes are never re-used;
//   4. the source note/txid has not funded any other payment.
// The amount is a second, NON-attributing check: a mismatch goes to MANUAL_REVIEW
// and is never re-attributed elsewhere. Amount or timing alone never attribute.
//
// Model in force: SINGLE ACTIVE CHECKOUT PER RECEIVING ADDRESS. Per-order
// diversified addresses are investigated in docs/INTEGRATION-GAP-REPORT.md.
import type { PaymentStore } from "./store.ts";
import { StoreError } from "./store.ts";

export class AttributionError extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "duplicate" | "underpayment" | "overpayment" | "unattributed",
  ) {
    super(message);
    this.name = "AttributionError";
  }
}

/**
 * Verify an exact detected payment against the quote. The allocation + txid is the
 * identity; the amount is a secondary, non-attributing check that must still pass.
 */
export function verifyDetected(
  expectedZat: string,
  detectedZat: string,
): { ok: true } | { ok: false; code: "underpayment" | "overpayment"; detectedZat: string } {
  const expected = BigInt(expectedZat);
  const detected = BigInt(detectedZat);
  if (detected < expected) return { ok: false, code: "underpayment", detectedZat };
  if (detected > expected) return { ok: false, code: "overpayment", detectedZat };
  return { ok: true };
}

export interface DepositObservation {
  /** Receiving address the note was decrypted for (UFVK-verified by the watcher). */
  address: string;
  /** Source transaction id (hex). */
  txid: string;
  /** Height of the block that mined the note. */
  height: number;
  /** Note value in zatoshis (integer string). */
  zat: string;
  /** Confirmations reported by the watch-only scanner. */
  confirmations: number;
}

export type AttributionResult =
  | { status: "attributed"; paymentId: string; state: string }
  | { status: "confirmed"; paymentId: string }
  | { status: "manual_review"; paymentId: string; reason: string }
  | { status: "unattributed"; reason: string }
  | { status: "duplicate"; paymentId: string };

/**
 * Apply one new (never seen before) watcher-verified note to the payment journal.
 * Never touches keys or the payout leg. Returns how the note was classified.
 */
export function attributeDeposit(
  store: PaymentStore,
  obs: DepositObservation,
  opts: { minConfirmations: number; now?: number },
): AttributionResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!/^[0-9a-f]{64}$/i.test(obs.txid) || !/^\d+$/.test(obs.zat) || !Number.isSafeInteger(obs.height))
    return { status: "unattributed", reason: "malformed_observation" };
  return store.tx(() => {
    const existing = store.db
      .prepare(`SELECT id FROM payments WHERE detected_txid=? AND mode IN ('monitor','live')`)
      .get(obs.txid) as { id: string } | undefined;
    if (existing) return { status: "duplicate", paymentId: existing.id };
    store.expireDue(now);
    const holder = store.allocationHolder(obs.address);
    const reject = (reason: string): AttributionResult => {
      store.recordUnattributed(obs.txid, obs.address, obs.zat, reason, now);
      return { status: "unattributed", reason };
    };
    if (!holder) return reject("no_active_checkout");
    if (holder.mode === "demo") return reject("holder_is_demo");
    if (holder.state !== "AWAITING_PAYMENT") return reject("holder_not_awaiting");
    if (holder.allocationTip === null || obs.height <= holder.allocationTip) return reject("note_predates_checkout");
    try {
      store.markDetected(holder.id, obs.txid, obs.zat, now, "mainnet-observed");
    } catch (e) {
      if (e instanceof StoreError && e.code === "duplicate_attribution")
        return { status: "duplicate", paymentId: String(e.details?.paymentId ?? "") };
      throw e;
    }
    store.setConfirmations(holder.id, obs.confirmations, now);
    const amount = verifyDetected(holder.quote!.zecAmountZat, obs.zat);
    if (!amount.ok) {
      store.transition(holder.id, "MANUAL_REVIEW", { reason: amount.code, detectedZat: obs.zat, evidence: "mainnet-observed" }, now);
      return { status: "manual_review", paymentId: holder.id, reason: amount.code };
    }
    return { status: "attributed", paymentId: holder.id, state: "VERIFYING" };
  });
}
