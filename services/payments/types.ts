// Payment lifecycle and domain types for ZecOne Checkout.
//
// A Payment is the durable record of one merchant-created checkout intent. It
// progresses through a strictly ordered state machine. Amounts are stored as
// fixed-point strings (see money.ts); never as numbers.
import type { WalletEvidence } from "./wallet-evidence.ts";

export const PAYMENT_STATES = [
  "CREATED",
  "QUOTED",
  "AWAITING_PAYMENT",
  "PAYMENT_DETECTED",
  "VERIFYING",
  "ZEC_CONFIRMED",
  "PAYOUT_PENDING",
  "PAYOUT_SUBMITTED",
  "PAYOUT_CONFIRMED",
  "COMPLETED",
  "EXPIRED",
  "FAILED",
  "MANUAL_REVIEW",
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<PaymentState> = new Set([
  "COMPLETED",
  "EXPIRED",
  "FAILED",
]);

/** API key scopes. Session credentials additionally carry `merchant:manage`. */
export const SCOPES = [
  "payments:create",
  "payments:read",
  "payments:cancel",
  "webhooks:manage",
  "merchant:manage",
] as const;
export type Scope = (typeof SCOPES)[number];

export const DEFAULT_API_SCOPES: Scope[] = [
  "payments:create",
  "payments:read",
  "payments:cancel",
  "webhooks:manage",
];

/** A quote binds an exact ZEC amount to an exact ETH payout at a point in time. */
export interface Quote {
  id: string;
  network: "zcash-mainnet";
  payoutChain: "base";
  // Fixed-point strings, decimal-safe.
  amountUsd: string;
  zecAmount: string; // amount the customer must pay
  zecAmountZat: string; // integer zatoshis
  ethPayout: string; // ETH the relayer will send
  ethPayoutWei: string; // integer wei
  feeZat: string; // network fee contribution, integer zatoshis
  rate: { numerator: string; denominator: string }; // ZEC->ETH rational rate
  rateSource?: "demo-fixed" | "live-authority";
  /** SHA-256 of the verified signed live statement; absent for demo pricing. */
  authorityDigest?: string;
  expiresAt: number; // unix seconds
  createdAt: number;
}

export interface PaymentRequest {
  amountUsd: string;
  payoutChain: "base";
  recipient: string; // Base address (EIP-55 checksummed)
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  description?: string;
}

/**
 * How a payment's on-chain facts were obtained.
 *  - "recorded-mainnet-replay": DEMO. Historical pilot transactions replayed; simulated, no funds moved for this payment.
 *  - "mainnet-observed": a real shielded deposit observed read-only by the authenticated mainnet watcher.
 *  - "live": reserved for live settlement (disabled in this build).
 */
export type EvidenceKind = "live" | "mainnet-observed" | "recorded-mainnet-replay";

/**
 * Operating mode of a payment:
 *  - "demo": simulated checkout; no payable address; completes by replaying recorded evidence.
 *  - "monitor": real receiving address; real deposits observed read-only; never pays out.
 *  - "live": live settlement — disabled in this build.
 */
export type PaymentMode = "demo" | "monitor" | "live";

/** Chain evidence recorded when the watcher attributes a real deposit. */
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
  merchantId: string;
  state: PaymentState;
  request: PaymentRequest;
  quote: Quote | null;
  // Shielded Zcash destination assigned to this payment (exclusive allocation).
  zcashAddress: string | null;
  // Attribution: the exact source txid + note once detected.
  detectedTxid: string | null;
  detectedZat: string | null;
  confirmations: number | null;
  evidenceKind: EvidenceKind | null;
  chainEvidence: ChainEvidence | null;
  /** Watcher chain tip when the receiving address was allocated (monitor mode). */
  allocationTip: number | null;
  /**
   * Real orders only. The address is shown until `paymentDeadline` (the quote
   * expiry, at most 300 s). A deposit qualifies only if its authenticated
   * inclusion height is in (allocationTip, paymentExpiryHeight]. The watcher
   * runs behind the tip, so the order stays allocated until absence of such a
   * deposit is proven or `observationDeadline` passes. Null for demo orders.
   */
  paymentDeadline: number | null;
  observationDeadline: number | null;
  paymentExpiryHeight: number | null;
  /**
   * Pilot only: integrated-wallet journal evidence that this exact transaction
   * was signed and broadcast before the payment deadline. Required before any
   * payout can be bound or recorded.
   */
  walletEvidence: WalletEvidence | null;
  // Base payout leg.
  payoutTxHash: string | null;
  payoutWei: string | null;
  // Timestamps (unix seconds).
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  completedAt: number | null;
  mode: PaymentMode;
  error: string | null;
}

export type PaymentEventType =
  | "payment.created"
  | "payment.quoted"
  | "payment.awaiting_payment"
  | "payment.detected"
  | "payment.verifying"
  | "payment.zec_confirmed"
  | "payment.payout_pending"
  | "payment.payout_submitted"
  | "payment.payout_confirmed"
  | "payment.completed"
  | "payment.expired"
  | "payment.failed"
  | "payment.manual_review"
  | "webhook.ping";

export interface PaymentEvent {
  id: number;
  paymentId: string;
  type: PaymentEventType;
  state: PaymentState;
  data: Record<string, unknown>;
  createdAt: number;
}

/** A signed webhook delivery attempt, retained for retry + audit. */
export interface WebhookDelivery {
  id: number;
  eventId: number | null;
  paymentId: string;
  merchantId: string;
  eventType: PaymentEventType;
  url: string;
  attempts: number;
  status: "pending" | "delivered" | "failed";
  lastStatus: number | null;
  nextAttemptAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
}

export interface Merchant {
  id: string;
  name: string;
  // Legacy primary key id (the first API key issued). Additional keys live in api_keys.
  keyId: string;
  keyHash: string;
  scopes: ReadonlySet<string>;
  webhookUrl: string | null;
  webhookSecret: string | null;
  /** Base payout address. Only set after a verified wallet-ownership proof (or operator config for the demo merchant). */
  baseRecipient: string | null;
  payoutVerification: "siwe" | "operator-configured" | null;
  ownerAddress: string | null;
  createdAt: number;
}

/** The authenticated principal behind a request. */
export interface Principal {
  merchant: Merchant;
  credential: "api_key" | "session";
  keyId: string;
  scopes: ReadonlySet<string>;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
