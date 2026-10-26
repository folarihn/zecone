// Public SDK types. Amounts are fixed-point strings, never numbers.
export type PayoutChain = "base";

export interface CreatePaymentInput {
  /** USD amount, decimal string with at most 2 decimals, e.g. "12.50". */
  amountUsd: string;
  /** Defaults to "base". */
  payoutChain?: PayoutChain;
  /** Optional; must equal your verified Base payout address. Defaults to it. */
  recipient?: string;
  /** Up to 20 string values (your order id, SKU...). Never shown to the customer. */
  metadata?: Record<string, string>;
  /** Shown to the customer on the checkout page (max 200 chars). */
  description?: string;
  /** Safe-retry key. The SDK generates one when omitted. */
  idempotencyKey?: string;
}

export type PaymentState =
  | "CREATED"
  | "QUOTED"
  | "AWAITING_PAYMENT"
  | "PAYMENT_DETECTED"
  | "VERIFYING"
  | "ZEC_CONFIRMED"
  | "PAYOUT_PENDING"
  | "PAYOUT_SUBMITTED"
  | "PAYOUT_CONFIRMED"
  | "COMPLETED"
  | "EXPIRED"
  | "FAILED"
  | "MANUAL_REVIEW";

export const TERMINAL_PAYMENT_STATES: readonly PaymentState[] = ["COMPLETED", "EXPIRED", "FAILED"];

export interface Quote {
  id: string;
  network: "zcash-mainnet";
  payoutChain: PayoutChain;
  amountUsd: string;
  zecAmount: string;
  zecAmountZat: string;
  ethPayout: string;
  ethPayoutWei: string;
  feeZat: string;
  rate: { numerator: string; denominator: string };
  rateSource?: "demo-fixed" | "live-authority";
  expiresAt: number;
  createdAt: number;
}

/** "recorded-mainnet-replay" = SIMULATED demo; "mainnet-observed" = real deposit seen read-only; "live" = live settlement. */
export type EvidenceKind = "live" | "mainnet-observed" | "recorded-mainnet-replay";
export type PaymentMode = "demo" | "monitor" | "live";

export interface ChainEvidence {
  noteKey: string;
  txid: string;
  pool: number;
  height: number;
  blockHash: string;
  zatoshis: string;
  confirmations: number;
  minimumConfirmations: number;
  tip: number;
  tipHash: string;
  ownershipDigest: string;
  paymentDigest: string | null;
  sources: [string, string];
  observedAt: number;
}

export interface Payment {
  id: string;
  object: "payment";
  state: PaymentState;
  mode: PaymentMode;
  livemode: boolean;
  /** True for demo checkouts: nothing payable, completion is a labelled replay. */
  simulated: boolean;
  /** Base payout leg. "disabled" in demo and monitor modes. */
  settlement: "disabled" | "operator-approved";
  request: { amountUsd: string; payoutChain: PayoutChain; recipient: string };
  description: string | null;
  metadata: Record<string, string> | null;
  quote: Quote | null;
  zcashAddress: string | null;
  /** ZIP-321 payment URI (render as a QR code). */
  paymentUri: string | null;
  /** Hosted checkout link, safe to share with the customer. */
  checkoutUrl: string;
  /** Read-only capability for the embedded checkout. Safe for the browser. */
  checkoutToken: string;
  detectedTxid: string | null;
  detectedZat: string | null;
  confirmations: number | null;
  evidenceKind: EvidenceKind | null;
  chainEvidence: ChainEvidence | null;
  payoutTxHash: string | null;
  payoutWei: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  completedAt: number | null;
  error: string | null;
}

export interface PaymentEvent {
  id: number;
  paymentId: string;
  type: string;
  state: PaymentState;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface Receipt {
  object: "receipt";
  paymentId: string;
  merchant: { id: string; name: string | null };
  mode: PaymentMode;
  simulated: boolean;
  evidenceKind: EvidenceKind | null;
  evidenceNote: string;
  amountUsd: string;
  zcash: {
    network: "zcash-mainnet";
    quotedZat: string | null;
    receivedZat: string | null;
    txid: string | null;
    block: number | null;
    confirmations: number | null;
  };
  payout: {
    chain: "base";
    recipient: string;
    wei: string | null;
    txHash: string | null;
    explorerUrl: string | null;
    block: number | null;
  };
  createdAt: number;
  completedAt: number | null;
  events: { type: string; state: PaymentState; at: number }[];
}

/** Public, token-scoped checkout view (what the customer's browser sees). */
export interface CheckoutView {
  id: string;
  object: "checkout";
  state: PaymentState;
  mode: PaymentMode;
  /** Demo checkout: no payable address is ever shown. */
  simulated: boolean;
  confirmations: number | null;
  minimumConfirmations: number | null;
  settlement: "disabled" | "operator-approved";
  merchant: { name: string };
  description: string | null;
  amountUsd: string;
  payoutChain: PayoutChain;
  recipient: string;
  quote: {
    zecAmount: string;
    zecAmountZat: string;
    ethPayout: string;
    rateSource: string;
    expiresAt: number;
  } | null;
  zcashAddress: string | null;
  paymentUri: string | null;
  paymentDetected: boolean;
  evidenceKind: EvidenceKind | null;
  payoutTxHash: string | null;
  payoutExplorerUrl: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  serverTime: number;
}

export interface MerchantProfile {
  id: string;
  object: "merchant";
  name: string;
  payoutAddress: string | null;
  payoutVerification: "siwe" | "operator-configured" | null;
  ownerAddress: string | null;
  webhookUrl: string | null;
  apiKeys: { keyId: string; createdAt: number; revokedAt: number | null; active: boolean; scopes: string[] }[];
  createdAt: number;
}

export interface WebhookEvent {
  id: string;
  type: string;
  /** Same as `type` (kept for compatibility). */
  event: string;
  created: number;
  livemode: boolean;
  attempt: number;
  payment: Payment | null;
}

export class ZecOneError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ZecOneError";
  }
}
