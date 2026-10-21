import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MainnetSubmissionJournal,
  type BaseFinalizedReceipt,
  type MainnetSubmitLimits,
} from "../services/settlement/mainnet-submitter.ts";
import type {
  MainnetTransferTerms,
  VerifiedMainnetBundle,
} from "../services/settlement/mainnet-transfer.ts";
import {
  BASE_MAINNET_CAIP,
  SOLANA_MAINNET_CAIP,
} from "../services/settlement/mainnet-address.ts";

function journal(
  ...args: ConstructorParameters<typeof MainnetSubmissionJournal>
) {
  const j = new MainnetSubmissionJournal(...args);
  j.resume();
  return j;
}
const now = 1_800_000_000;
const terms = (
  over: Partial<MainnetTransferTerms> = {},
): MainnetTransferTerms => ({
  version: 1,
  network: "solana",
  destinationNetwork: SOLANA_MAINNET_CAIP,
  relayer: "11111111111111111111111111111112",
  recipient: "11111111111111111111111111111113",
  amount: "1000000",
  feeCap: "5000",
  l1DataFeeBound: "0",
  maximumDestinationDebit: "1005000",
  sourceNetwork: "zcash-mainnet",
  sourceZatoshis: "2000000",
  sourcePaymentCommitment: "a".repeat(64),
  destinationBinding: "b".repeat(64),
  quoteDigest: "c".repeat(64),
  profileDigest: "d".repeat(64),
  expires: now + 600,
  ...over,
});
const bundle = (t = terms()): VerifiedMainnetBundle => ({
  version: 1,
  network: t.network,
  termsDigest: "e".repeat(64),
  preparedDigest: "f".repeat(64),
  signed: "synthetic-signed-bundle",
  transactionId: "s".repeat(64),
  signedDigest: "1".repeat(64),
  totalFee: t.feeCap,
  broadcast: false,
});
const limits: MainnetSubmitLimits = {
  perTransaction: "2000000",
  daily: "4000000",
  confirmations: 1,
};
const receipt = (t = terms()) => ({
  genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  signature: "s".repeat(64),
  slot: 123,
  confirmationStatus: "finalized" as const,
  err: null,
});

test("bookkeeping claims metadata once and rejects caller-created finality evidence", () => {
  const j = journal(":memory:", limits, () => now),
    t = terms(),
    b = bundle(t);
  j.prepare(t, b);
  j.prepare(t, b);
  const claim = j.claim(b.termsDigest);
  assert.equal(claim.attempt, 1);
  assert.equal(claim.signed, b.signed);
  assert.throws(() => j.claim(b.termsDigest), /NOT_CLAIMABLE/);
  assert.throws(
    () => j.finalizeSolana(b.termsDigest, receipt(t), t),
    /CANONICAL_FINALITY/,
  );
  j.markBroadcast(b.termsDigest, b.transactionId);
  assert.throws(
    () => j.finalizeSolana(b.termsDigest, { ...receipt(t), slot: 0 }, t),
    /CANONICAL_FINALITY/,
  );
  assert.throws(
    () => j.finalizeSolana(b.termsDigest, receipt(t), t),
    /CANONICAL_FINALITY/,
  );
  assert.equal(j.status(b.termsDigest).state, "broadcast");
  assert.throws(
    () => j.finalizeSolana(b.termsDigest, receipt(t), t),
    /CANONICAL_FINALITY/,
  );
});

test("submitter rejects replayed source payments, wrong broadcast ids and pauses", () => {
  const j = journal(":memory:", limits, () => now),
    t = terms(),
    b = bundle(t);
  j.prepare(t, b);
  assert.throws(
    () =>
      j.prepare(t, {
        ...b,
        termsDigest: "8".repeat(64),
        transactionId: "s".repeat(63) + "t",
      }),
    /REPLAY/,
  );
  const claim = j.claim(b.termsDigest);
  assert.throws(
    () => j.markBroadcast(b.termsDigest, "other"),
    /BROADCAST_ID_MISMATCH/,
  );
  j.markUncertain(b.termsDigest, "RPC_TIMEOUT");
  assert.equal(j.status(b.termsDigest).state, "uncertain");
  j.pause("operator emergency");
  assert.throws(() => j.claim(claim.orderId), /PAUSED/);
  j.resume();
});

test("submitter enforces per-transaction and daily limits", () => {
  const j = journal(":memory:", { ...limits, daily: "3000000" }, () => now),
    a = terms(),
    b = terms({
      sourcePaymentCommitment: "2".repeat(64),
      maximumDestinationDebit: "2000000",
    });
  j.prepare(a, bundle(a));
  assert.throws(
    () =>
      j.prepare(b, {
        ...bundle(b),
        termsDigest: "3".repeat(64),
        transactionId: "4".repeat(64),
      }),
    /DAILY_LIMIT/,
  );
  assert.throws(
    () =>
      j.prepare(
        terms({ maximumDestinationDebit: "2000001" }),
        bundle(terms({ maximumDestinationDebit: "2000001" })),
      ),
    /INVALID_MAINNET_SUBMISSION/,
  );
});

test("Base bookkeeping refuses raw receipt metadata even when depth and recipient match", () => {
  const j = journal(":memory:", { ...limits, confirmations: 12 }, () => now),
    t = terms({ network: "base", destinationNetwork: BASE_MAINNET_CAIP }),
    b = { ...bundle(t), transactionId: "0x" + "a".repeat(64) },
    r: BaseFinalizedReceipt = {
      chainId: 8453,
      transactionHash: "0x" + "a".repeat(64),
      status: "success",
      blockNumber: 100,
      confirmations: 11,
      to: t.recipient,
      value: t.amount,
    };
  j.prepare(t, b);
  j.claim(b.termsDigest);
  j.markBroadcast(b.termsDigest, b.transactionId);
  assert.throws(
    () => j.finalizeBase(b.termsDigest, r, t),
    /CANONICAL_FINALITY/,
  );
  assert.throws(
    () => j.finalizeBase(b.termsDigest, { ...r, confirmations: 12 }, t),
    /CANONICAL_FINALITY/,
  );
});
