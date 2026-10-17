import { digest } from "./transactions.ts";
import { json, SolanaError } from "./network.ts";
import type { SolanaSettlement } from "./settlement.ts";
import type { SwapPrepared } from "./cpmm.ts";

// Economic review is NOT signing/broadcast authorization. Exact bytes still need approval.
export function economicReview(service: SolanaSettlement, id: string) {
  const i = service.eligible(id);
  if (!i.swap) throw new SolanaError("SWAP_REQUIRED");
  const termsDigest = digest(json(i));
  const reviewUntil = Math.min(i.expiry, service.now() + 1800);
  service.store.db.exec(
    "CREATE TABLE IF NOT EXISTS solana_economic_reviews(order_id TEXT PRIMARY KEY,terms_digest TEXT NOT NULL,review_until INTEGER NOT NULL)",
  );
  service.store.db
    .prepare(
      "INSERT INTO solana_economic_reviews VALUES(?,?,?) ON CONFLICT(order_id) DO UPDATE SET terms_digest=excluded.terms_digest,review_until=excluded.review_until",
    )
    .run(id, termsDigest, reviewUntil);
  service.store.event(
    id,
    "economic_review_opened_not_approval",
    { termsDigest, reviewUntil },
    service.now(),
  );
  return {
    termsDigest,
    reviewUntil,
    recipient: i.recipient,
    relayer: i.relayer,
    swap: i.swap,
    feeCap: i.feeCap,
    rentCap: "6000000",
    maximumDebit: "7010000",
    authorizesBroadcast: false,
  };
}
export function checkEconomicReview(
  service: SolanaSettlement,
  id: string,
  termsDigest: string,
) {
  const i = service.eligible(id);
  const r = service.store.db
    .prepare("SELECT * FROM solana_economic_reviews WHERE order_id=?")
    .get(id);
  if (
    !r ||
    r.terms_digest !== termsDigest ||
    termsDigest !== digest(json(i)) ||
    Number(r.review_until) <= service.now()
  )
    throw new SolanaError("ECONOMIC_REVIEW_EXPIRED_OR_CHANGED");
}
export function approvalDeadline(p: SwapPrepared) {
  return p.approvalExpiresAt ?? p.expiresAt;
}
export function quoteDeadline(p: SwapPrepared) {
  return p.quoteExpiresAt ?? p.expiresAt;
}
export function assertReviewCurrent(p: SwapPrepared, now: number) {
  if (approvalDeadline(p) <= now)
    throw new SolanaError("USER_APPROVAL_EXPIRED");
  if (quoteDeadline(p) <= now) throw new SolanaError("SWAP_QUOTE_EXPIRED");
}
