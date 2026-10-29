// Payment and observation deadlines for real (monitor-mode) orders.
//
// The customer may submit only while the quote is valid (`paymentDeadline`, at
// most 300 s). Chain time is proven by height, not by miner-set block
// timestamps, so a deposit qualifies only if its authenticated inclusion height
// is at most `paymentExpiryHeight`, derived once from the verified watcher tip
// and persisted. ZecOne-prepared payments carry that height as their Zcash
// expiry, so the protocol itself refuses to mine them later. The watcher
// authenticates blocks behind the tip, so detection may come after the payment
// deadline; the order stays allocated until `observationDeadline`.

/** Zcash target block spacing since Blossom (seconds). */
export const ZCASH_TARGET_SPACING_SECONDS = 75;
/**
 * Blocks added after the expected end of the payment window. Zcash nodes refuse
 * transactions that expire within 3 blocks (ZIP-203), so a payment submitted at
 * the deadline needs an expiry comfortably above the tip at that moment.
 */
export const INCLUSION_MARGIN_BLOCKS = 5;
/** Refuse to allocate when the bound would be implausibly far (stale tip). */
export const MAX_INCLUSION_BLOCKS = 24;
export const DEFAULT_OBSERVATION_GRACE_SECONDS = 2700;
export const MIN_OBSERVATION_GRACE_SECONDS = 900;
export const MAX_OBSERVATION_GRACE_SECONDS = 7200;

export class PaymentWindowError extends Error {}

export function paymentWindow(input: {
  now: number;
  /** Quote expiry (at most 300 s for the pilot); the address is shown until then. */
  paymentDeadline: number;
  /** Verified watcher tip recorded as the allocation tip. */
  tip: number;
  /** When that tip was observed. */
  tipObservedAt: number;
  observationGraceSeconds: number;
}): {
  paymentDeadline: number;
  observationDeadline: number;
  paymentExpiryHeight: number;
} {
  const {
    now,
    paymentDeadline,
    tip,
    tipObservedAt,
    observationGraceSeconds: grace,
  } = input;
  const windowSeconds = paymentDeadline - now;
  if (
    ![now, paymentDeadline, tip, tipObservedAt, grace].every(
      Number.isSafeInteger,
    ) ||
    windowSeconds < 1 ||
    // The pilot's 300 s cap is enforced by its configuration and signed quote;
    // read-only monitor checkouts may use longer demo-rate quotes.
    windowSeconds > 900 ||
    tip < 1 ||
    tipObservedAt > now + 60 ||
    grace < MIN_OBSERVATION_GRACE_SECONDS ||
    grace > MAX_OBSERVATION_GRACE_SECONDS
  )
    throw new PaymentWindowError("PAYMENT_WINDOW_INVALID");
  // Blocks the chain can be expected to add between the observed tip and the
  // payment deadline, plus the ZIP-203 margin.
  const elapsed = Math.max(0, now - tipObservedAt) + windowSeconds;
  const blocks =
    Math.ceil(elapsed / ZCASH_TARGET_SPACING_SECONDS) + INCLUSION_MARGIN_BLOCKS;
  if (blocks > MAX_INCLUSION_BLOCKS)
    throw new PaymentWindowError("WATCHER_TIP_TOO_OLD_FOR_INCLUSION_BOUND");
  return {
    paymentDeadline,
    observationDeadline: paymentDeadline + grace,
    paymentExpiryHeight: tip + blocks,
  };
}
