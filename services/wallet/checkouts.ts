// Restricted backend projection, not an HTTP response. Apply checkoutBrowserView
// and session handles before serialization. Never authorizes a payment,
// advances a lifecycle, retries a transaction or marks a refund complete.
export type CheckoutKind =
  "mint" | "action" | "purchase" | "swap" | "seaport" | "solana";
export type CheckoutSource = {
  id: string;
  kind?: string;
  status: string;
  stage: string;
  orderState?: string | null;
  expiry: number;
  chainId?: number;
  networkName?: string;
  recipient?: string;
  zatoshis?: string;
  receivedZatoshis?: string;
  confirmations: number;
  requiredConfirmations: number;
  paymentTx?: string | null;
  baseTx?: string | null;
  ownerVerified?: boolean;
  paymentAddress?: string | null;
  receiptVerified?: boolean;
  manualRecovery?: boolean;
  recovery?: string | null;
  tokenId?: string | null;
  nft?: string;
  token?: string;
  minOut?: string;
  slippageBps?: string | number;
  refundPolicy?: string;
  fee?: { feeZatoshis?: string; totalZatoshis?: string } | null;
  quote?: { feeZatoshis: string; totalZatoshis: string } | null;
};
export function checkoutState(r: CheckoutSource, now: number) {
  if (
    r.manualRecovery ||
    (r.recovery && r.status !== "Failed") ||
    /review|recovery/i.test(r.status) ||
    r.stage === "review"
  )
    return "RECOVERY_REQUIRED";
  // Never infer REFUNDED from text or a prepared request. Existing live refund gate is closed.
  if (/refund/i.test(r.status)) return "REFUND_AWAITING_AUTHORIZATION";
  if (r.status === "Completed") return "COMPLETED";
  if (r.status === "Failed" && r.orderState !== "expired")
    return "EXECUTION_FAILED";
  // A paid/uncertain transaction must be reconciled even after its quote expires.
  if (r.baseTx || r.status === "Executing") return "DESTINATION_EXECUTION";
  if (
    r.paymentTx ||
    BigInt(r.receivedZatoshis ?? "0") > 0n ||
    ["sending", "sent"].includes(r.stage)
  )
    return "PAYMENT_CONFIRMATIONS";
  if (r.expiry <= now || r.status === "Expired") return "PAYMENT_EXPIRED";
  if (r.stage === "draft") return "USER_REVIEW";
  return "PAYMENT_REQUEST";
}
export function unifiedCheckouts<K extends CheckoutKind>(
  groups: { kind: K; rows: CheckoutSource[] }[],
  recipient: string,
  now = Math.floor(Date.now() / 1000),
) {
  return groups.flatMap((g) =>
    g.rows.map((r) => ({
      key: `${g.kind}:${r.id}`,
      id: r.id,
      kind: g.kind,
      state: checkoutState(r, now),
      status: r.status,
      stage: r.stage,
      chainId: (g.kind === "solana"
        ? null
        : (r.chainId ?? 84532)) as K extends "solana" ? null : number,
      networkName: r.networkName ?? "Base Sepolia",
      recipient: r.recipient ?? recipient,
      zatoshis: r.zatoshis ?? null,
      expiry: r.expiry,
      confirmations: r.confirmations,
      requiredConfirmations: r.requiredConfirmations,
      paymentTx: r.paymentTx ?? null,
      paymentAddress: r.paymentAddress ?? null,
      destinationTx: r.baseTx ?? null,
      asset: r.token ?? r.nft ?? null,
      tokenId: r.tokenId ?? null,
      minOut: r.minOut ?? null,
      slippageBps: r.slippageBps ?? null,
      fee: r.fee ?? r.quote ?? null,
      recovery:
        r.recovery ??
        (r.manualRecovery
          ? (r.refundPolicy ?? "Manual review required; do not pay again.")
          : null),
      resultVerified:
        g.kind === "swap"
          ? r.receiptVerified === true
          : g.kind === "mint" || g.kind === "action"
            ? r.status === "Completed"
            : r.ownerVerified === true,
      pricing: "simulated-testnet",
      settlement: "trusted-prefunded-relayer",
      liveRefundsEnabled: false,
    })),
  );
}
export type UnifiedCheckout = ReturnType<typeof unifiedCheckouts>[number];
export function revealPaymentRequest(
  id: string,
  order: { address: string; state: string; intent: string },
  received: bigint,
  now: number,
) {
  const intent = JSON.parse(order.intent);
  if (
    !order.address.startsWith("utest1") &&
    !order.address.startsWith("ztestsapling1")
  )
    throw Error("testnet_shielded_payment_request_required");
  if (
    order.state !== "awaiting_payment" ||
    received > 0n ||
    intent.expiry <= now
  )
    throw Error("payment_request_not_payable_reconcile_existing_payment");
  return {
    id,
    address: order.address,
    zatoshis: intent.zatoshis,
    expiry: intent.expiry,
    network: "zcash-testnet",
    broadcast: false,
  };
}
