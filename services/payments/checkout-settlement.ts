// Operator-side bookkeeping that connects a monitor-mode checkout order to the
// existing operator payout session (scripts/mainnet-pilot-session.ts) and back.
//
// REUSE, NOT RE-IMPLEMENTATION: the payout is still prepared, priced, reviewed,
// signed, broadcast and reconciled only by the existing session and executor,
// behind the exact SIGN and BROADCAST approvals. This module never signs,
// submits or reads keys. It only
//   1. derives the immutable watch-order binding and source commitment for a
//      ZEC_CONFIRMED checkout order (`checkoutSettlementBinding`), and
//   2. copies the outcome of the existing submission journal back onto that
//      order (`recordCheckoutPayout`) so the checkout and receipt show the real
//      Base transaction. It opens the journal read-only and trusts no typed hash.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getAddress, isAddress } from "viem";
import type { PaymentStore } from "./store.ts";
import type { Payment } from "./types.ts";

const HEX64 = /^[a-f0-9]{64}$/;
const BASE_TX = /^0x[a-f0-9]{64}$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Watch-order id for a checkout payment; the watcher bridge binds the same id. */
export const checkoutOrderId = (paymentId: string) =>
  createHash("sha256").update(`zecone-payment:${paymentId}`).digest("hex");

export class CheckoutSettlementError extends Error {}
const fail = (code: string): never => {
  throw new CheckoutSettlementError(code);
};

/** A real deposit the watcher confirmed and bound to its payment digest. */
function confirmedOrder(p: Payment | null): Payment & { chainEvidence: NonNullable<Payment["chainEvidence"]> } {
  if (!p) return fail("CHECKOUT_PAYMENT_NOT_FOUND");
  if (p.mode !== "monitor") return fail("CHECKOUT_NOT_REAL_MAINNET_ORDER");
  if (p.evidenceKind !== "mainnet-observed") return fail("CHECKOUT_EVIDENCE_NOT_MAINNET_OBSERVED");
  const e = p.chainEvidence;
  if (!e || !e.paymentDigest || !HEX64.test(e.paymentDigest) || !HEX64.test(e.ownershipDigest))
    return fail("CHECKOUT_PAYMENT_DIGEST_MISSING");
  if (e.confirmations < e.minimumConfirmations || e.minimumConfirmations < 20)
    return fail("CHECKOUT_CONFIRMATIONS_INSUFFICIENT");
  if (!p.quote || e.zatoshis !== p.quote.zecAmountZat || p.detectedZat !== p.quote.zecAmountZat || p.detectedTxid !== e.txid)
    return fail("CHECKOUT_AMOUNT_OR_SOURCE_MISMATCH");
  if (!isAddress(p.request.recipient)) return fail("CHECKOUT_RECIPIENT_INVALID");
  return p as Payment & { chainEvidence: NonNullable<Payment["chainEvidence"]> };
}

export interface CheckoutSettlementBinding {
  checkoutPaymentId: string;
  watchBinding: {
    orderId: string;
    account: string;
    address: string;
    zatoshis: string;
    sourceEvidenceDigest: string;
    expires: number;
  };
  sourceEvidenceDigest: string;
  sourceCommitment: string;
  sourceZatoshis: string;
  quotedPayoutWei: string;
  recipient: string;
}

/**
 * Order-specific fields for the operator payout session. Only a ZEC_CONFIRMED,
 * watcher-verified order whose payout recipient is the operator's single
 * allow-listed recipient qualifies. `account` is the reviewed native account
 * from the operator's existing configuration; the session's own native scan
 * re-verifies every value before pricing.
 */
export function checkoutSettlementBinding(
  store: PaymentStore,
  paymentId: string,
  opts: { account: string; allowedRecipient: string; windowSeconds: number; now: number },
): CheckoutSettlementBinding {
  const p = confirmedOrder(store.getPayment(paymentId));
  if (p.state !== "ZEC_CONFIRMED") fail("CHECKOUT_NOT_ZEC_CONFIRMED");
  if (!HEX64.test(opts.account)) fail("NATIVE_ACCOUNT_INVALID");
  if (!isAddress(opts.allowedRecipient) || getAddress(p.request.recipient) !== getAddress(opts.allowedRecipient))
    fail("CHECKOUT_RECIPIENT_NOT_ALLOWLISTED");
  if (!Number.isSafeInteger(opts.windowSeconds) || opts.windowSeconds < 300 || opts.windowSeconds > 6 * 3600)
    fail("SETTLEMENT_WINDOW_INVALID");
  const e = p.chainEvidence;
  return {
    checkoutPaymentId: p.id,
    watchBinding: {
      orderId: checkoutOrderId(p.id),
      account: opts.account,
      address: p.zcashAddress ?? fail("CHECKOUT_ADDRESS_MISSING"),
      zatoshis: e.zatoshis,
      sourceEvidenceDigest: e.ownershipDigest,
      expires: opts.now + opts.windowSeconds,
    },
    sourceEvidenceDigest: e.ownershipDigest,
    sourceCommitment: e.paymentDigest!,
    sourceZatoshis: e.zatoshis,
    quotedPayoutWei: p.quote!.ethPayoutWei,
    recipient: getAddress(p.request.recipient),
  };
}

type SubmissionRow = {
  order_id: string;
  network: string;
  source_commitment: string;
  transaction_id: string;
  broadcast_txid: string | null;
  state: string;
  finalized_ref: string | null;
  terms_binding: string | null;
};

type PlanTerms = {
  network: string;
  recipient: string;
  amount: string;
  sourceZatoshis: string;
  sourcePaymentCommitment: string;
};

export type RecordOutcome =
  | { status: "submitted" | "completed"; state: Payment["state"]; txHash: string; wei: string }
  | { status: "reconcile_required" | "not_submitted"; state: Payment["state"]; journalState: string | null };

/**
 * Copy the payout outcome from the existing submission journal onto the order.
 * Idempotent: re-running only advances as far as the journal has progressed.
 * `broadcast` → PAYOUT_SUBMITTED; `finalized` (via the existing `reconcile`
 * command) → PAYOUT_CONFIRMED → COMPLETED. Anything else changes nothing.
 */
export function recordCheckoutPayout(
  store: PaymentStore,
  paymentId: string,
  journalPath: string,
  terms: PlanTerms,
  now: number,
): RecordOutcome {
  const p = confirmedOrder(store.getPayment(paymentId));
  const e = p.chainEvidence;
  const journal = new DatabaseSync(journalPath, { readOnly: true });
  let row: SubmissionRow | undefined;
  try {
    row = journal
      .prepare("SELECT * FROM mainnet_submissions WHERE order_id=?")
      .get(checkoutOrderId(p.id)) as SubmissionRow | undefined;
  } finally {
    journal.close();
  }
  if (!row) return { status: "not_submitted", state: p.state, journalState: null };
  // The journal row, the reviewed plan terms and the checkout order must all agree.
  if (
    row.network !== "base" ||
    terms.network !== "base" ||
    row.source_commitment !== e.paymentDigest ||
    terms.sourcePaymentCommitment !== e.paymentDigest ||
    row.terms_binding !== digest(terms) ||
    terms.sourceZatoshis !== e.zatoshis ||
    terms.amount !== p.quote!.ethPayoutWei ||
    !isAddress(terms.recipient) ||
    getAddress(terms.recipient) !== getAddress(p.request.recipient) ||
    !/^[1-9][0-9]{0,30}$/.test(terms.amount) ||
    !BASE_TX.test(row.transaction_id)
  )
    fail("PAYOUT_JOURNAL_DOES_NOT_MATCH_ORDER");
  if (
    (row.state === "broadcast" || row.state === "finalized") &&
    row.broadcast_txid !== row.transaction_id
  )
    fail("PAYOUT_JOURNAL_BROADCAST_TXID_MISMATCH");
  if (
    row.state === "finalized" &&
    (row.finalized_ref === null || !/^[1-9][0-9]{0,15}$/.test(row.finalized_ref))
  )
    fail("PAYOUT_JOURNAL_FINALITY_INVALID");
  if (row.state !== "broadcast" && row.state !== "finalized")
    return {
      status: row.state === "prepared" ? "not_submitted" : "reconcile_required",
      state: p.state,
      journalState: row.state,
    };
  if (p.payoutTxHash !== null && p.payoutTxHash !== row.transaction_id) fail("CHECKOUT_PAYOUT_ALREADY_RECORDED");
  store.tx(() => {
    const evidence = { evidence: "mainnet-observed", sourceCommitment: e.paymentDigest, txHash: row!.transaction_id };
    if (p.state === "ZEC_CONFIRMED") {
      store.transition(p.id, "PAYOUT_PENDING", { ...evidence, settlement: "operator-approved" }, now);
      store.setPayout(p.id, row!.transaction_id, terms.amount, now);
    }
    if (store.getPayment(p.id)!.state === "PAYOUT_PENDING")
      store.transition(p.id, "PAYOUT_SUBMITTED", { ...evidence, wei: terms.amount }, now);
    if (row!.state === "finalized" && store.getPayment(p.id)!.state === "PAYOUT_SUBMITTED") {
      store.transition(p.id, "PAYOUT_CONFIRMED", { ...evidence, block: row!.finalized_ref }, now);
      store.transition(p.id, "COMPLETED", evidence, now);
    }
  });
  const final = store.getPayment(p.id)!;
  if (final.payoutTxHash !== row.transaction_id) fail("CHECKOUT_PAYOUT_STATE_UNEXPECTED");
  return {
    status: final.state === "COMPLETED" ? "completed" : "submitted",
    state: final.state,
    txHash: row.transaction_id,
    wei: terms.amount,
  };
}
