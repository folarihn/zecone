import { createHash } from "node:crypto";
import { digest } from "../settlement/protocol.ts";
export type PaymentReview = {
  version: 1;
  profileId: string;
  requestId: string;
  network: "zcash-testnet";
  recipient: string;
  zatoshis: "100000";
  feeZatoshis: string;
  expiryHeight: number;
  txid: string;
  rawSha256: string;
  rawBytes: number;
};
export function reviewPhase52Payment(
  profileId: string,
  requestId: string,
  destination: string,
  record: any,
  raw: Buffer,
): PaymentReview {
  if (
    record.recipient !== destination ||
    record.zatoshis !== "100000" ||
    !/^[a-f0-9]{64}$/.test(record.txid) ||
    typeof record.feeZatoshis !== "string" ||
    !/^[1-9][0-9]*$/.test(record.feeZatoshis) ||
    BigInt(record.feeZatoshis) > 10000n ||
    !Number.isSafeInteger(record.expiryHeight) ||
    record.expiryHeight < 1 ||
    raw.length < 100 ||
    raw.length > 262144
  )
    throw Error("fixed_payment_review_conflict");
  return {
    version: 1,
    profileId,
    requestId,
    network: "zcash-testnet",
    recipient: record.recipient,
    zatoshis: "100000",
    feeZatoshis: record.feeZatoshis,
    expiryHeight: record.expiryHeight,
    txid: record.txid,
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    rawBytes: raw.length,
  };
}
export function requireExactPaymentApproval(
  review: PaymentReview,
  approved: string,
  tip: number,
) {
  if (
    !Number.isSafeInteger(tip) ||
    tip < 1 ||
    tip >= review.expiryHeight ||
    approved !== digest(review)
  )
    throw Error("exact_unexpired_payment_approval_required");
}
