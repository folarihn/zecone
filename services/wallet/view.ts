// Explicit allowlist: never serialize Store.report(), native accounts, or signing material.
import type { Store, Order } from "../execution/store.ts";
import type { Checkout } from "./state.ts";
export type Progress =
  | "Awaiting payment"
  | "Payment detected"
  | "Confirming"
  | "Settled"
  | "Executing"
  | "Completed"
  | "Failed"
  | "Manual review required";
export function progress(
  state: Order["state"] | undefined,
  stage: string,
  received: string,
  confirmations: number,
): Progress {
  if (state === "settled") return "Completed";
  if (state === "recovery" || stage === "review")
    return "Manual review required";
  if (state === "expired" || state === "failed") return "Failed";
  if (state === "submitted" || state === "prepared") return "Executing";
  if (state === "verified") return "Settled";
  if (BigInt(received) > 0n)
    return confirmations > 1 ? "Confirming" : "Payment detected";
  return "Awaiting payment";
}
export function checkoutView(c: Checkout, store: Store, tip: number) {
  const o = c.order_id ? store.get(c.order_id) : undefined;
  const total = o ? store.totals(o.id) : { received: 0n, confirmed: 0n };
  const notes = o
    ? (store.db
        .prepare("SELECT height FROM payments WHERE order_id=? AND active=1")
        .all(o.id) as { height: number }[])
    : [];
  const confirmations = notes.length
    ? Math.max(0, Math.min(...notes.map((p) => tip - p.height + 1)))
    : 0;
  const quote = c.quote ? JSON.parse(c.quote) : null;
  const status = progress(
    o?.state,
    c.stage,
    total.received.toString(),
    confirmations,
  );
  return {
    id: c.id,
    kind: JSON.parse(c.intent).kind === 'action' ? 'action' as const : 'mint' as const,
    actionTarget: JSON.parse(c.intent).kind === 'action' ? JSON.parse(c.intent).target as string : null,
    status,
    stage: c.stage,
    created: c.created,
    expiry: JSON.parse(c.intent).expiry,
    receivedZatoshis: total.received.toString(),
    confirmations,
    requiredConfirmations: 10,
    paymentTx: c.txid,
    baseTx: o?.tx_hash ?? null,
    tokenId: JSON.parse(c.intent).kind!=='action' && o?.state === "settled" ? BigInt(o.id).toString() : null,
    quote: quote
      ? {
          id: quote.id,
          feeZatoshis: quote.feeZatoshis,
          totalZatoshis: quote.totalZatoshis,
          expires: quote.expires,
        }
      : null,
    recovery: ["Failed", "Manual review required"].includes(status)
      ? "Do not pay again. Keep this checkout and its transaction references. Use Recheck status, then contact the local operator if it remains unresolved. Refunds require manual review; no automatic refund is available."
      : null,
  };
}
export type CheckoutView = ReturnType<typeof checkoutView>;
export type WalletSummary = {
  totalZatoshis: string;
  spendableZatoshis: string;
  tip: number;
  scanned: number;
  observedAt: number;
  history: {
    txid: string;
    height: number | null;
    deltaZatoshis: string;
    feeZatoshis: string | null;
    time: number | null;
    expired: boolean;
  }[];
};
export type Dashboard = {
  address: string;
  contract: string;
  priceZatoshis: string;
  zcash: WalletSummary | null;
  base: { wei: string; block: string; observedAt: number } | null;
  health: { zcash: string; base: string; worker: string; busy: boolean };
  nfts: { tokenId: string; hash: string; verifiedAt: number }[];
  baseActivity: { hash: string; status: string; kind: "action" | "mint"; tokenId: string | null }[];
  checkouts: CheckoutView[];
};
