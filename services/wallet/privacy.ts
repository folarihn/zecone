import { randomUUID } from "node:crypto";
import { ApiError, type Session } from "./security.ts";

export const INSPECTION_WARNING =
  "Private local inspection may link shielded funding to a public destination. The trusted operator can already correlate both. Do not share or export this view.";

// Display handles are references only. Every inspection must also recheck its
// backend ownership and normal session/CSRF policy. Aliases never grant signing
// authority: the existing exact review/session checks remain authoritative.
export class CheckoutScopes {
  private sessions = new Map<
    string,
    {
      expires: number;
      scope: string;
      handles: Map<string, { kind: string; id: string }>;
    }
  >();
  constructor(readonly now = () => Date.now()) {}
  private current(s: Session) {
    for (const [id, row] of this.sessions)
      if (row.expires <= this.now()) this.sessions.delete(id);
    if (s.expires <= this.now()) throw new ApiError(401, "Session expired.");
    let row = this.sessions.get(s.id);
    if (!row) {
      if (this.sessions.size >= 100)
        throw new ApiError(429, "Session capacity reached.");
      row = { expires: s.expires, scope: randomUUID(), handles: new Map() };
      this.sessions.set(s.id, row);
    }
    return row;
  }
  metadata(s: Session) {
    const row = this.current(s);
    return { selectionScope: row.scope, selectionExpires: row.expires };
  }
  handle(s: Session, kind: string, id: string) {
    const row = this.current(s);
    for (const [handle, target] of row.handles)
      if (target.kind === kind && target.id === id) return handle;
    if (row.handles.size >= 1000)
      throw new ApiError(429, "Checkout capacity reached.");
    const handle = randomUUID();
    row.handles.set(handle, { kind, id });
    return handle;
  }
  resolve(s: Session, handle: unknown, kind: unknown) {
    const target = this.current(s).handles.get(String(handle));
    if (!target || target.kind !== kind)
      throw new ApiError(404, "Unknown checkout.");
    return target.id;
  }
  forget(s: Session) {
    this.sessions.delete(s.id);
  }
}

// Explicit projection at the HTTP boundary. The underlying unified projection
// remains an operator-side adapter: its identifiers are never sent as-is here.
export function checkoutBrowserView(r: any, handle: string) {
  return {
    key: `${r.kind}:${handle}`,
    id: handle,
    kind: r.kind,
    state: r.state,
    status: r.status,
    stage: r.stage,
    chainId: r.chainId,
    networkName: r.networkName,
    recipient: r.recipient,
    zatoshis: r.zatoshis,
    expiry: r.expiry,
    confirmations: r.confirmations,
    requiredConfirmations: r.requiredConfirmations,
    paymentTx: null,
    paymentAddress: null,
    destinationTx: r.destinationTx ?? null,
    asset: r.asset ?? null,
    tokenId: r.tokenId ?? null,
    minOut: r.minOut ?? null,
    slippageBps: r.slippageBps ?? null,
    fee: r.fee
      ? { feeZatoshis: r.fee.feeZatoshis, totalZatoshis: r.fee.totalZatoshis }
      : null,
    recovery: r.recovery
      ? "Preserve the checkout and ask the local operator to reconcile. Do not pay again."
      : null,
    resultVerified: r.resultVerified === true,
    pricing: "simulated-testnet",
    settlement: "trusted-prefunded-relayer",
    liveRefundsEnabled: false,
  };
}
export function paymentInspection(r: any) {
  return {
    address: r.address,
    zatoshis: r.zatoshis,
    expiry: r.expiry ?? r.expires,
    network: "zcash-testnet",
    broadcast: false,
    privacy: INSPECTION_WARNING,
  };
}
export function listingBrowserView(
  r: any,
  handle: string,
  quoteHandle?: string,
): any {
  const result: Record<string, unknown> = { id: handle, paymentTx: null };
  for (const key of [
    "kind",
    "status",
    "stage",
    "orderState",
    "created",
    "expiry",
    "chainId",
    "networkName",
    "explorer",
    "recipient",
    "nft",
    "token",
    "tokenId",
    "listingId",
    "origin",
    "seller",
    "price",
    "gasBudget",
    "zatoshis",
    "receivedZatoshis",
    "confirmations",
    "requiredConfirmations",
    "baseTx",
    "ownerVerified",
    "receiptVerified",
    "manualRecovery",
    "amountIn",
    "minOut",
    "slippageBps",
    "actionTarget",
  ])
    if (
      ["string", "number", "boolean"].includes(typeof r[key]) ||
      r[key] === null
    )
      result[key] = r[key];
  result.recovery = r.recovery
    ? "Preserve this checkout; ask the local operator to reconcile. Do not pay again."
    : null;
  result.refundPolicy = "Manual review only. Live refunds disabled.";
  result.quote = r.quote
    ? {
        id: quoteHandle,
        feeZatoshis: r.quote.feeZatoshis,
        totalZatoshis: r.quote.totalZatoshis,
        expires: r.quote.expires,
      }
    : null;
  result.fee = r.fee
    ? { feeZatoshis: r.fee.feeZatoshis, totalZatoshis: r.fee.totalZatoshis }
    : null;
  return result;
}
export function dashboardBrowserView(
  d: any,
  handle: (id: string) => string,
  quoteHandle?: (id: string) => string,
): any {
  return {
    address: d.address,
    readOnlyNotice: d.readOnlyNotice,
    contract: d.contract,
    priceZatoshis: d.priceZatoshis,
    zcash: d.zcash
      ? {
          totalZatoshis: d.zcash.totalZatoshis,
          spendableZatoshis: d.zcash.spendableZatoshis,
          tip: d.zcash.tip,
          scanned: d.zcash.scanned,
          observedAt: d.zcash.observedAt,
          history: [],
        }
      : null,
    base: d.base
      ? { wei: d.base.wei, block: d.base.block, observedAt: d.base.observedAt }
      : null,
    health: {
      zcash: d.zcash ? "Wallet summary available" : "Unavailable",
      base: d.base ? "Balance available" : "Unavailable",
      worker: "Use checkout status; private diagnostics withheld",
      busy: d.health?.busy === true,
    },
    nfts: (d.nfts ?? []).map((r: any) => ({
      tokenId: r.tokenId,
      hash: r.hash,
      verifiedAt: r.verifiedAt,
    })),
    baseActivity: (d.baseActivity ?? []).map((r: any) => ({
      hash: r.hash,
      status: r.status,
      kind: r.kind,
      tokenId: r.tokenId,
      networkName: r.networkName,
      explorer: r.explorer,
    })),
    checkouts: (d.checkouts ?? []).map((r: any) =>
      listingBrowserView(
        r,
        handle(r.id),
        r.quote?.id ? quoteHandle?.(r.quote.id) : undefined,
      ),
    ),
    recoverySnapshot: d.recoverySnapshot
      ? {
          refundZatoshis: d.recoverySnapshot.refundZatoshis,
          feeZatoshis: d.recoverySnapshot.feeZatoshis,
          paymentTx: "Private reference withheld",
          expiryHeight: d.recoverySnapshot.expiryHeight,
          archivedAt: d.recoverySnapshot.archivedAt,
        }
      : undefined,
  };
}

// A closed diagnostic vocabulary; arbitrary exceptions/objects are never copied.
const CODES = [
  "INVALID_REQUEST",
  "ACCESS_DENIED",
  "RPC_UNAVAILABLE",
  "INSPECTION_DENIED",
] as const;
type Code = (typeof CODES)[number];
export class PrivacyDiagnostics {
  private rows: { at: number; code: Code }[] = [];
  constructor(readonly now = () => Date.now()) {}
  private prune() {
    this.rows = this.rows
      .filter((r) => r.at > this.now() - 86400000)
      .slice(-100);
  }
  record(code: Code, _discarded?: unknown) {
    if (!CODES.includes(code)) throw Error("Unsafe diagnostic code");
    this.prune();
    this.rows.push({ at: this.now(), code });
    this.prune();
  }
  export() {
    this.prune();
    return {
      version: 1,
      retention: "24h-or-100-events",
      counts: CODES.map((code) => ({
        code,
        count: this.rows.filter((r) => r.code === code).length,
      })),
    };
  }
}
export function privacyError(error: unknown) {
  const status = error instanceof ApiError ? error.status : 400;
  const messages: Record<number, string> = {
    401: "Your session expired. Pair locally again.",
    403: "Access denied. Verify ownership and explicitly request local inspection.",
    404: "Checkout or operation unavailable.",
    409: "Checkout expired, paid or unavailable; preserve records and reconcile. Do not pay again.",
    413: "Request too large.",
    415: "JSON is required.",
    429: "Too many requests. Try later.",
  };
  return {
    status,
    body: {
      error:
        messages[status] ??
        "Request unavailable. Preserve records and ask the local operator.",
    },
  };
}
