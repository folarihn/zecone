/** Read-only assessment. Never authorizes a broadcast or clears a wallet claim. */
export type TransferRecoveryEvidence = {
  network: string;
  requestBindingMatches: boolean;
  constructionMarker: boolean;
  savedTxid: string | null;
  rawTransactionPersisted: boolean;
  expiryHeight: number | null;
  tip: number;
  scanned: number;
  observedAt: number;
  sourceMatches: number;
  matchingReceipt: {
    txid: string;
    height: number;
    exactDestinationAndAmount: boolean;
  } | null;
  providerStatus: "unknown" | "pending" | "mined" | "not-found" | "rejected";
};
export function assessTransferRecovery(
  e: TransferRecoveryEvidence,
  now: number,
) {
  const result = (status: string, missing: string[]) => ({
    status,
    missing,
    replacementAuthorized: false as const,
    markersMayBeCleared: false as const,
    broadcastAuthorized: false as const,
  });
  if (e.network !== "zcash-testnet" || !e.requestBindingMatches)
    return result("evidence-conflict", ["exact testnet request binding"]);
  if (
    !Number.isSafeInteger(e.tip) ||
    e.tip < 1 ||
    e.scanned !== e.tip ||
    !Number.isSafeInteger(e.observedAt) ||
    e.observedAt > now + 5 ||
    now - e.observedAt > 120
  )
    return result("stale-or-incomplete-scan", [
      "fresh complete recipient scan",
    ]);
  if (e.matchingReceipt) {
    const p = e.matchingReceipt;
    if (
      !p.exactDestinationAndAmount ||
      !/^[a-f0-9]{64}$/.test(p.txid) ||
      !Number.isSafeInteger(p.height) ||
      p.height < 1 ||
      p.height > e.tip ||
      (e.savedTxid !== null && e.savedTxid !== p.txid)
    )
      return result("evidence-conflict", ["consistent exact receipt"]);
    if (e.savedTxid === null)
      return result("exact-receipt-origin-unattributed", [
        "source transaction identity linking receipt to interrupted request",
      ]);
    return result(
      e.tip - p.height + 1 >= 10
        ? "confirmed-exact-receipt"
        : "mined-awaiting-confirmations",
      [],
    );
  }
  if (
    !e.savedTxid ||
    !/^[a-f0-9]{64}$/.test(e.savedTxid) ||
    !e.rawTransactionPersisted
  )
    return result("uncertain-no-transaction-reference", [
      "original transaction identity and bytes",
      "actual transaction expiry",
      "input selection and independent inclusion/absence evidence",
    ]);
  if (e.providerStatus === "pending")
    return result("broadcast-pending", ["confirmed recipient receipt"]);
  if (e.providerStatus === "mined")
    return result("evidence-conflict", [
      "recipient scan must agree with claimed inclusion",
    ]);
  if (
    e.expiryHeight !== null &&
    Number.isSafeInteger(e.expiryHeight) &&
    e.expiryHeight > 0 &&
    e.tip > e.expiryHeight
  )
    return result("past-expiry-requires-absence-and-input-review", [
      "conclusive unmined evidence",
      "fresh source input spendability",
      "explicit replacement approval",
    ]);
  // Rejection, not-found, no expiry, and sourceMatches=0 do not prove safe replacement.
  return result("constructed-outcome-unresolved", [
    "inclusion/absence and input-state reconciliation",
  ]);
}
