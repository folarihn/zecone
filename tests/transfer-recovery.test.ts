import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessTransferRecovery,
  type TransferRecoveryEvidence,
} from "../services/settlement/transfer-recovery.ts";
const now = 1800000000,
  txid = "a".repeat(64);
const base: TransferRecoveryEvidence = {
  network: "zcash-testnet",
  requestBindingMatches: true,
  constructionMarker: true,
  savedTxid: null,
  rawTransactionPersisted: false,
  expiryHeight: null,
  tip: 500,
  scanned: 500,
  observedAt: now,
  sourceMatches: 0,
  matchingReceipt: null,
  providerStatus: "unknown",
};
test("missing hash, old marker and arbitrarily advanced tip never permit replacement", () => {
  for (const tip of [500, 5000000]) {
    const r = assessTransferRecovery({ ...base, tip, scanned: tip }, now);
    assert.equal(r.status, "uncertain-no-transaction-reference");
    assert.equal(r.replacementAuthorized, false);
    assert.equal(r.markersMayBeCleared, false);
  }
});
test("expiry boundary, rejection and provider absence do not authorize another payment", () => {
  for (const providerStatus of ["not-found", "rejected", "unknown"] as const)
    for (const expiryHeight of [0, 499, 500, 501]) {
      const r = assessTransferRecovery(
        {
          ...base,
          savedTxid: txid,
          rawTransactionPersisted: true,
          expiryHeight,
          providerStatus,
        },
        now,
      );
      assert.equal(r.replacementAuthorized, false);
      assert.equal(r.broadcastAuthorized, false);
      assert.equal(
        r.status,
        expiryHeight === 499
          ? "past-expiry-requires-absence-and-input-review"
          : "constructed-outcome-unresolved",
      );
    }
});
test("exact receipt requires ten confirmations; reorg removes settlement evidence", () => {
  const e = {
    ...base,
    savedTxid: txid,
    rawTransactionPersisted: true,
    matchingReceipt: { txid, height: 492, exactDestinationAndAmount: true },
  };
  assert.equal(
    assessTransferRecovery(e, now).status,
    "mined-awaiting-confirmations",
  );
  assert.equal(
    assessTransferRecovery({ ...e, tip: 501, scanned: 501 }, now).status,
    "confirmed-exact-receipt",
  );
  assert.notEqual(
    assessTransferRecovery({ ...e, matchingReceipt: null }, now).status,
    "confirmed-exact-receipt",
  );
});
test("incorrect destination, conflicting txid, stale scanner and mainnet fail closed", () => {
  assert.equal(
    assessTransferRecovery({ ...base, network: "mainnet" }, now).status,
    "evidence-conflict",
  );
  assert.equal(
    assessTransferRecovery({ ...base, requestBindingMatches: false }, now)
      .status,
    "evidence-conflict",
  );
  for (const e of [
    { ...base, scanned: 499 },
    { ...base, observedAt: now - 121 },
    { ...base, observedAt: now + 6 },
  ])
    assert.equal(
      assessTransferRecovery(e, now).status,
      "stale-or-incomplete-scan",
    );
  for (const p of [
    { txid, height: 490, exactDestinationAndAmount: false },
    { txid: "b".repeat(64), height: 490, exactDestinationAndAmount: true },
  ])
    assert.equal(
      assessTransferRecovery(
        { ...base, savedTxid: txid, matchingReceipt: p },
        now,
      ).status,
      "evidence-conflict",
    );
});
test("pending broadcasts and provider/scanner disagreement retain recovery gate", () => {
  const e = { ...base, savedTxid: txid, rawTransactionPersisted: true };
  assert.equal(
    assessTransferRecovery({ ...e, providerStatus: "pending" }, now).status,
    "broadcast-pending",
  );
  assert.equal(
    assessTransferRecovery({ ...e, providerStatus: "mined" }, now).status,
    "evidence-conflict",
  );
  assert.deepEqual(
    assessTransferRecovery(e, now),
    assessTransferRecovery(JSON.parse(JSON.stringify(e)), now),
  );
});
test("a same-amount external deposit cannot prove the interrupted source transfer succeeded", () => {
  const r = assessTransferRecovery(
    {
      ...base,
      matchingReceipt: { txid, height: 490, exactDestinationAndAmount: true },
    },
    now,
  );
  assert.equal(r.status, "exact-receipt-origin-unattributed");
  assert.equal(r.replacementAuthorized, false);
});
