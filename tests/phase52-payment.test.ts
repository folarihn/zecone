import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reviewPhase52Payment,
  requireExactPaymentApproval,
} from "../services/validation/phase52-payment-review.ts";
import { digest } from "../services/settlement/protocol.ts";
const record = {
  recipient: "fixed-destination",
  zatoshis: "100000",
  feeZatoshis: "10000",
  txid: "a".repeat(64),
  expiryHeight: 140,
};
test("payment approval binds exact bytes, fee, recipient, amount and expiry", () => {
  const r = reviewPhase52Payment(
    "profile",
    "request",
    record.recipient,
    record,
    Buffer.alloc(100, 1),
  );
  requireExactPaymentApproval(r, digest(r), 139);
  for (const x of [
    { ...r, recipient: "other" },
    { ...r, rawSha256: "b".repeat(64) },
    { ...r, feeZatoshis: "9999" },
    { ...r, expiryHeight: 141 },
  ])
    assert.throws(() => requireExactPaymentApproval(x, digest(r), 139));
});
test("wrong effects, excessive fees and expiry cannot authorize a broadcast", () => {
  for (const x of [
    { ...record, recipient: "other" },
    { ...record, zatoshis: "200000" },
    { ...record, feeZatoshis: "10001" },
    { ...record, expiryHeight: 0 },
  ])
    assert.throws(() =>
      reviewPhase52Payment("p", "r", record.recipient, x, Buffer.alloc(100)),
    );
  const r = reviewPhase52Payment(
    "p",
    "r",
    record.recipient,
    record,
    Buffer.alloc(100),
  );
  for (const tip of [140, 141])
    assert.throws(() => requireExactPaymentApproval(r, digest(r), tip));
});
