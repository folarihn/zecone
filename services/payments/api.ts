// ZecOne Merchant Payment API — request handling, independent of the listener so
// it can be exercised in-process by tests and embedded by the server entry point.
//
// SECURITY BOUNDARY
//   * This process never loads spending keys, relayer keys or operator signing
//     credentials. Payout authorization is not reachable from this surface: the
//     API creates and reads payment intents; the Base payout stays an
//     operator-controlled, separately approved action (SIGN + BROADCAST gates).
//   * Three separated operating modes:
//       demo    — simulated checkouts: no payable address, completion only by
//                 replaying recorded mainnet evidence (labelled as such);
//       monitor — real receiving address; real deposits are observed READ-ONLY
//                 through the authenticated mainnet watcher and stop at
//                 ZEC_CONFIRMED; nothing here can authorize a Base payout;
//       live    — live settlement; refused at startup in this build.
//   * Merchant credentials are only issued after an EIP-4361 wallet-ownership proof.
//   * Authenticated endpoints send no CORS headers, so browsers cannot use a
//     merchant key cross-origin. Only the token-scoped public checkout view and
//     the quote preview are CORS-readable.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { getAddress, isAddress } from "viem";
import { PaymentStore, StoreError, hashSecret } from "./store.ts";
import { DemoQuoteEngine, type QuoteEngine } from "./quote.ts";
import { MoneyError, parseUnits } from "./money.ts";
import { BASE_EXPLORER_TX, DemoObserver, MAINNET_EVIDENCE, replayToCompletion } from "./demo.ts";
import { WebhookDispatcher, validateWebhookUrl, type Fetcher } from "./webhooks.ts";
import { SiweError, createChallenge, verifyChallenge, type SiweConfig } from "./siwe.ts";
import { InsufficientLiquidityError, assertLiquidity } from "./liquidity.ts";
import { PaymentWatchBridge, type SnapshotSource } from "./watch-bridge.ts";
import { OperatorFeedError, OperatorWatchFeed, basePayoutCheck, type BasePayoutCheck } from "./operator-feed.ts";
import { OperatorPilotQuoteEngine, PilotQuoteError } from "./pilot-quote.ts";
import { DEFAULT_API_SCOPES } from "./types.ts";
import {
  DEFAULT_OBSERVATION_GRACE_SECONDS,
  MAX_OBSERVATION_GRACE_SECONDS,
  MIN_OBSERVATION_GRACE_SECONDS,
  PaymentWindowError,
  paymentWindow,
} from "./payment-window.ts";
import type { ApiError, Merchant, Payment, PaymentRequest, PaymentState, Principal } from "./types.ts";
import type { Quote } from "./types.ts";

export interface PaymentsConfig {
  dbPath: string;
  /** Public shielded receiving address (unified address). Never derived from input. */
  checkoutAddress: string;
  mode: "demo" | "monitor" | "live";
  /**
   * Monitor mode only: the authenticated mainnet watcher and an explicit operator
   * acknowledgement that real ZEC sent to the checkout address will NOT be paid out
   * automatically (settlement is disabled).
   */
  monitor?: {
    authorized: boolean;
    /** In-process watcher, or "operator": results pushed by the operator machine (no viewing key here). */
    source: SnapshotSource | "operator";
    minimumConfirmations: number;
    intervalSeconds: number;
    maxSnapshotAgeSeconds?: number;
    lock?: { acquire(): void; release(): void };
  } | null;
  /**
   * Restricted mainnet pilot (operator-fed monitor mode): real orders only for the
   * one approved merchant, capped per order, settled by the operator workflow.
   * Other merchants are refused; the demo storefront keeps creating simulated orders.
   */
  pilot?: {
    merchantOwner: string;
    maxAmountUsd: string;
    maxPayoutWei: bigint;
    payout: BasePayoutCheck;
    /**
     * An enabled, independently verified pricing authority. DemoQuoteEngine is
     * deliberately disabled and can never satisfy this boundary.
     */
    quoteEngine: QuoteEngine;
  } | null;
  /** Serve operator routes only on the separate loopback operator listener. */
  operatorListenerOnly?: boolean;
  /** Demo storefront merchant used by the ZecOne website and examples (optional). */
  demoMerchant?: { secret: string; payoutAddress: string; name?: string } | null;
  siwe: SiweConfig;
  /** Base URL of the hosted checkout (ZecOne web app), e.g. http://localhost:3000 */
  publicCheckoutBaseUrl: string;
  /** Bearer token for loopback operator endpoints. Unset disables them. */
  operatorToken?: string | null;
  /** Single-active-checkout enforcement for the shared receiving address. */
  exclusiveAllocation: boolean;
  quoteTtlSeconds: number;
  /** Real orders: how long after the payment deadline the watcher may still prove a qualifying deposit. */
  observationGraceSeconds?: number;
  maxAmountUsd: string;
  /** Operator-supplied relayer balance snapshot (wei) used by the liquidity guard. */
  relayerAvailableWei: bigint;
  demoObserver: { enabled: boolean; startAfterSeconds: number; stepSeconds: number };
  allowLoopbackHttpWebhooks: boolean;
  sessionTtlSeconds: number;
  /** Honor the first X-Forwarded-For hop only behind the private demo reverse proxy. */
  trustedProxy?: boolean;
  fetcher?: Fetcher;
  /** Injectable clock for tests. */
  now?: () => number;
}

export const DEFAULT_CHECKOUT_ADDRESS =
  "u1qqq8z5wnpx5yft50ahvm2cq3rzumnszs2r53ccruhnk4xrv3su4wtgxwvwz5chqfv8l2v7atn83kdjcfmp9lpaf7clwu32yufqhf4eah6r0k5dvxq85nc8ky2keej6cz9wlr8aflajelgsy4s8nj8j3s388t4l9zejcfe5dcevdmnyr2";
export const DEMO_KEY_ID = "zk_" + "0".repeat(24);

const BASE_RECIPIENT_DEFAULT = "0x4b5750d7675f14eB844B74477015302Bf31AE2dB";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export interface PaymentsApp {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Handler for the loopback-only operator listener (never behind the public proxy). */
  handleOperator(req: IncomingMessage, res: ServerResponse): Promise<void>;
  feed: OperatorWatchFeed | null;
  store: PaymentStore;
  dispatcher: WebhookDispatcher;
  observer: DemoObserver;
  bridge: PaymentWatchBridge | null;
  /** One maintenance pass: expire quotes, advance the demo observer, drain webhooks. */
  tick(): Promise<void>;
  start(): void;
  close(): void;
  demoApiKey: string | null;
  checkoutToken(paymentId: string): string;
}

export function createPaymentsApp(config: PaymentsConfig): PaymentsApp {
  if (config.mode === "live" || (config.mode !== "demo" && config.mode !== "monitor")) {
    // Live settlement is operator-gated outside this process. Refuse to start a
    // public API that claims to be live.
    throw new Error("LIVE_MODE_DISABLED: live settlement is disabled in this build (use demo or monitor)");
  }
  if (config.mode === "monitor") {
    if (!config.monitor?.authorized)
      throw new Error("MONITOR_NOT_AUTHORIZED: monitor mode shows a real receiving address and requires explicit operator authorization");
    if (config.monitor.minimumConfirmations < 20) throw new Error("MONITOR_CONFIRMATIONS_TOO_LOW");
    // Simulated demo orders may share the API only when real orders are restricted to one
    // approved merchant: demo payments never receive the real address (per-payment mode).
    if (config.demoMerchant && !config.pilot)
      throw new Error("MONITOR_DEMO_MERCHANT_FORBIDDEN: the demo storefront cannot run against a real address");
    if (config.monitor.source === "operator" && (!config.pilot || !config.operatorToken || config.operatorToken.length < 32))
      throw new Error("OPERATOR_FEED_REQUIRES_PILOT_AND_OPERATOR_TOKEN");
    if (config.pilot && !isAddress(config.pilot.merchantOwner)) throw new Error("PILOT_MERCHANT_OWNER_INVALID");
    if (config.pilot) {
      if (config.monitor.source !== "operator" || !config.operatorListenerOnly)
        throw new Error("PILOT_OPERATOR_ISOLATION_REQUIRED");
      if (!config.operatorToken || config.operatorToken.length < 48)
        throw new Error("PILOT_OPERATOR_TOKEN_TOO_WEAK");
      if (!config.pilot.quoteEngine.enabled)
        throw new Error("PILOT_LIVE_QUOTE_AUTHORITY_REQUIRED");
      if (!Number.isSafeInteger(config.quoteTtlSeconds) || config.quoteTtlSeconds < 1 || config.quoteTtlSeconds > 300)
        throw new Error("PILOT_QUOTE_TTL_INVALID");
      const grace = config.observationGraceSeconds ?? DEFAULT_OBSERVATION_GRACE_SECONDS;
      if (!Number.isSafeInteger(grace) || grace < MIN_OBSERVATION_GRACE_SECONDS || grace > MAX_OBSERVATION_GRACE_SECONDS)
        throw new Error("PILOT_OBSERVATION_GRACE_INVALID");
      const pilotLimit = parseUnits(config.pilot.maxAmountUsd, "usd");
      if (pilotLimit < 1n || pilotLimit > 100n) throw new Error("PILOT_AMOUNT_LIMIT_INVALID");
      if (config.pilot.maxPayoutWei <= 0n || config.pilot.maxPayoutWei > config.relayerAvailableWei)
        throw new Error("PILOT_PAYOUT_LIMIT_EXCEEDS_LIQUIDITY");
    }
  }
  const MODE: "demo" | "monitor" = config.mode;
  const clock = config.now ?? (() => Math.floor(Date.now() / 1000));
  const store = new PaymentStore(config.dbPath);
  const demoQuoteEngine = new DemoQuoteEngine(config.quoteTtlSeconds);
  const maxAmountCents = parseUnits(config.maxAmountUsd, "usd");
  const checkoutSecret = store.secretSetting("checkout_token_secret");

  const checkoutToken = (paymentId: string) =>
    createHmac("sha256", checkoutSecret).update(`checkout:${paymentId}`).digest("hex").slice(0, 40);
  const checkoutTokenValid = (paymentId: string, token: string | null) => {
    if (!token || !/^[0-9a-f]{40}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(checkoutToken(paymentId)), Buffer.from(token));
  };
  const checkoutUrl = (p: Payment) =>
    `${config.publicCheckoutBaseUrl.replace(/\/+$/, "")}/pay/${p.id}?t=${checkoutToken(p.id)}`;

  // ---- demo storefront merchant (operator-configured payout, clearly labeled) ----
  let demoApiKey: string | null = null;
  if (config.demoMerchant) {
    const key = `${DEMO_KEY_ID}_${config.demoMerchant.secret}`;
    const existing = store.authenticatePrincipal(key, clock());
    if (!existing) {
      const prior = store.db.prepare(`SELECT id FROM merchants WHERE key_id=?`).get(DEMO_KEY_ID) as
        | { id: string }
        | undefined;
      if (prior) {
        // Secret changed between runs: rotate the stored hash for the fixed demo key id.
        store.db.prepare(`UPDATE merchants SET key_hash=? WHERE id=?`).run(hashSecret(config.demoMerchant.secret), prior.id);
        store.db
          .prepare(`UPDATE api_keys SET key_hash=?, revoked_at=NULL WHERE key_id=?`)
          .run(hashSecret(config.demoMerchant.secret), DEMO_KEY_ID);
      } else {
        store.createMerchant({
          name: config.demoMerchant.name ?? "ZecOne Demo Store",
          secret: config.demoMerchant.secret,
          scopes: [...DEFAULT_API_SCOPES],
          baseRecipient: getAddress(config.demoMerchant.payoutAddress),
          payoutVerification: "operator-configured",
          keyId: DEMO_KEY_ID,
        });
      }
    }
    demoApiKey = key;
  }

  const dispatcher = new WebhookDispatcher(
    store,
    (paymentId) => {
      const p = store.getPayment(paymentId);
      return p ? merchantPayment(p) : null;
    },
    config.fetcher,
    false,
  );
  const observer = new DemoObserver(store, {
    startAfterSeconds: config.demoObserver.startAfterSeconds,
    stepSeconds: config.demoObserver.stepSeconds,
  });
  const feed =
    MODE === "monitor" && config.monitor?.source === "operator" && config.pilot
      ? new OperatorWatchFeed(store, {
          minimumConfirmations: config.monitor.minimumConfirmations,
          maxPayoutWei: config.pilot.maxPayoutWei,
          payout: config.pilot.payout,
          now: clock,
        })
      : null;
  const pilotCents = config.pilot ? parseUnits(config.pilot.maxAmountUsd, "usd") : null;
  const validLiveQuote = (quote: Quote, amountUsd: string, now: number) => {
    try {
      return (
        quote.network === "zcash-mainnet" &&
        quote.payoutChain === "base" &&
        /^q_[a-zA-Z0-9_-]{8,80}$/.test(quote.id) &&
        quote.rateSource === "live-authority" &&
        typeof quote.authorityDigest === "string" &&
        /^[a-f0-9]{64}$/.test(quote.authorityDigest) &&
        quote.amountUsd === amountUsd &&
        quote.createdAt <= now + 5 &&
        quote.createdAt >= now - 90 &&
        quote.expiresAt > now &&
        quote.expiresAt - quote.createdAt <= config.quoteTtlSeconds &&
        /^[1-9]\d{0,20}$/.test(quote.zecAmountZat) &&
        /^[1-9]\d{0,30}$/.test(quote.ethPayoutWei) &&
        /^\d{1,20}$/.test(quote.feeZat) &&
        /^[1-9]\d{0,40}$/.test(quote.rate.numerator) &&
        /^[1-9]\d{0,40}$/.test(quote.rate.denominator) &&
        parseUnits(quote.zecAmount, "zec") === BigInt(quote.zecAmountZat) &&
        parseUnits(quote.ethPayout, "eth") === BigInt(quote.ethPayoutWei) &&
        BigInt(quote.ethPayoutWei) <= config.pilot!.maxPayoutWei
      );
    } catch {
      return false;
    }
  };
  const bridge =
    MODE === "monitor" && config.monitor && config.monitor.source !== "operator"
      ? new PaymentWatchBridge(store, config.monitor.source as SnapshotSource, {
          receivingAddress: config.checkoutAddress,
          minimumConfirmations: config.monitor.minimumConfirmations,
          lock: config.monitor.lock,
          now: clock,
        })
      : null;

  // ---- rate limiting (token bucket per principal / client address) ----
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  function rateLimit(key: string, capacity: number, refillPerSecond: number): boolean {
    const now = Date.now() / 1000;
    const b = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    b.tokens = Math.min(capacity, b.tokens + (now - b.updatedAt) * refillPerSecond);
    b.updatedAt = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.clear();
    return ok;
  }

  // ---- views ----
  function zip321(p: Payment): string | null {
    // Never a payable URI for a simulated checkout.
    if (p.mode === "demo" || !p.zcashAddress || !p.quote) return null;
    return `zcash:${p.zcashAddress}?amount=${p.quote.zecAmount}&label=${encodeURIComponent("ZecOne Checkout")}`;
  }

  function merchantPayment(p: Payment) {
    return {
      id: p.id,
      object: "payment",
      state: p.state,
      mode: p.mode,
      livemode: p.mode === "live",
      simulated: p.mode === "demo",
      settlement: p.mode === "live" || p.payoutTxHash || (p.mode === "monitor" && feed) ? "operator-approved" : "disabled",
      request: { amountUsd: p.request.amountUsd, payoutChain: p.request.payoutChain, recipient: p.request.recipient },
      description: p.request.description ?? null,
      metadata: p.request.metadata ?? null,
      quote: p.quote,
      zcashAddress: p.zcashAddress,
      paymentUri: zip321(p),
      checkoutUrl: checkoutUrl(p),
      checkoutToken: checkoutToken(p.id),
      detectedTxid: p.detectedTxid,
      detectedZat: p.detectedZat,
      confirmations: p.confirmations,
      evidenceKind: p.evidenceKind,
      chainEvidence: p.chainEvidence,
      payoutTxHash: p.payoutTxHash,
      payoutWei: p.payoutWei,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      expiresAt: p.expiresAt,
      paymentDeadline: p.paymentDeadline,
      observationDeadline: p.observationDeadline,
      paymentExpiryHeight: p.paymentExpiryHeight,
      completedAt: p.completedAt,
      error: p.error,
    };
  }

  /** Latest MANUAL_REVIEW reason, only if it is a public, non-identifying code. */
  const PUBLIC_REVIEW_REASONS = new Set([
    "chain_reorganization",
    "late_deposit",
    "observation_incomplete",
    "owned_note_requirements_not_met",
    "underpayment",
    "overpayment",
  ]);
  function reviewReason(id: string): string | null {
    const reason = [...store.listEvents(id)].reverse().find((e) => e.state === "MANUAL_REVIEW")?.data.reason;
    return typeof reason === "string" && (PUBLIC_REVIEW_REASONS.has(reason) || /^[a-z_]{1,48}_disagreement$/.test(reason))
      ? reason
      : null;
  }

  /** Payable only while awaiting payment and before the payment deadline. */
  function payable(p: Payment) {
    const deadline = p.paymentDeadline ?? p.expiresAt;
    return p.state === "AWAITING_PAYMENT" && deadline !== null && clock() < deadline;
  }

  /** Public, token-scoped checkout view: no metadata, no merchant ids, no source txid. */
  function checkoutView(p: Payment) {
    const merchant = store.getMerchant(p.merchantId);
    return {
      id: p.id,
      object: "checkout",
      state: p.state,
      mode: p.mode,
      merchant: { name: merchant?.name ?? "Merchant" },
      description: p.request.description ?? null,
      amountUsd: p.request.amountUsd,
      payoutChain: p.request.payoutChain,
      recipient: p.request.recipient,
      quote: p.quote
        ? {
            zecAmount: p.quote.zecAmount,
            zecAmountZat: p.quote.zecAmountZat,
            ethPayout: p.quote.ethPayout,
            rateSource: p.quote.rateSource ?? "demo-fixed",
            expiresAt: p.quote.expiresAt,
          }
        : null,
      simulated: p.mode === "demo",
      // A real, payable address is only ever shown for an authorized monitor/live
      // checkout, and only until its payment deadline, even while the watcher is
      // still observing for a deposit mined before that deadline.
      zcashAddress: p.mode !== "demo" && payable(p) ? p.zcashAddress : null,
      paymentUri: payable(p) ? zip321(p) : null,
      paymentDeadline: p.paymentDeadline ?? p.expiresAt,
      observationDeadline: p.observationDeadline,
      reviewReason: p.state === "MANUAL_REVIEW" ? reviewReason(p.id) : null,
      paymentDetected: p.detectedTxid !== null,
      confirmations: p.mode === "demo" ? null : p.confirmations,
      minimumConfirmations: p.mode === "demo" ? null : (p.chainEvidence?.minimumConfirmations ?? config.monitor?.minimumConfirmations ?? null),
      settlement: p.mode === "live" || p.payoutTxHash || (p.mode === "monitor" && feed) ? "operator-approved" : "disabled",
      evidenceKind: p.evidenceKind,
      payoutTxHash: p.payoutTxHash,
      payoutExplorerUrl: p.payoutTxHash ? BASE_EXPLORER_TX(p.payoutTxHash) : null,
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      serverTime: clock(),
    };
  }

  function receipt(p: Payment) {
    const merchant = store.getMerchant(p.merchantId);
    return {
      object: "receipt",
      paymentId: p.id,
      merchant: { id: p.merchantId, name: merchant?.name ?? null },
      mode: p.mode,
      evidenceKind: p.evidenceKind,
      simulated: p.mode === "demo",
      evidenceNote:
        p.evidenceKind === "recorded-mainnet-replay"
          ? "SIMULATED (demo replay): on-chain references are recorded ZecOne mainnet pilot transactions replayed for this payment. No funds moved for this payment and no payout was made."
          : "Live receipt.",
      amountUsd: p.request.amountUsd,
      zcash: {
        network: "zcash-mainnet",
        quotedZat: p.quote?.zecAmountZat ?? null,
        receivedZat: p.detectedZat,
        txid: p.detectedTxid,
        block: p.evidenceKind === "recorded-mainnet-replay" ? MAINNET_EVIDENCE.zcashDeposit.block : null,
        confirmations: p.confirmations,
      },
      payout: {
        chain: "base",
        recipient: p.request.recipient,
        wei: p.payoutWei,
        txHash: p.payoutTxHash,
        explorerUrl: p.payoutTxHash ? BASE_EXPLORER_TX(p.payoutTxHash) : null,
        block: p.evidenceKind === "recorded-mainnet-replay" ? MAINNET_EVIDENCE.basePayout.block : null,
      },
      createdAt: p.createdAt,
      completedAt: p.completedAt,
      events: store.listEvents(p.id).map((e) => ({ type: e.type, state: e.state, at: e.createdAt })),
    };
  }

  function merchantView(m: Merchant) {
    return {
      id: m.id,
      object: "merchant",
      name: m.name,
      payoutAddress: m.baseRecipient,
      payoutVerification: m.payoutVerification,
      ownerAddress: m.ownerAddress,
      webhookUrl: m.webhookUrl,
      apiKeys: store.listApiKeys(m.id).map((k) => ({ ...k, active: k.revokedAt === null })),
      createdAt: m.createdAt,
    };
  }

  // ---- io helpers ----
  function send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(value, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
  }

  function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new HttpError(413, "body_too_large", "request body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (chunks.length === 0) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!v || typeof v !== "object" || Array.isArray(v))
            return reject(new HttpError(400, "invalid_json", "JSON object body required"));
          resolve(v as Record<string, unknown>);
        } catch {
          reject(new HttpError(400, "invalid_json", "malformed JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  function clientKey(req: IncomingMessage): string {
    if (config.trustedProxy) {
      const header = req.headers["x-forwarded-for"];
      const forwarded = (Array.isArray(header) ? header[0] : header)
        ?.split(",")[0]
        ?.trim();
      if (forwarded && isIP(forwarded)) return forwarded;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function isLoopback(req: IncomingMessage): boolean {
    const addr = req.socket.remoteAddress ?? "";
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  }

  function authenticate(req: IncomingMessage, scope?: string, sessionOnly = false): Principal {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) throw new HttpError(401, "unauthorized", "missing API key");
    if (!rateLimit(`k:${token.slice(0, 27)}`, 120, 10)) throw new HttpError(429, "rate_limited", "too many requests");
    const principal = store.authenticatePrincipal(token, clock());
    if (!principal) throw new HttpError(401, "unauthorized", "invalid or revoked credential");
    if (sessionOnly && principal.credential !== "session")
      throw new HttpError(403, "session_required", "this action requires a wallet-verified dashboard session");
    if (scope && !principal.scopes.has(scope))
      throw new HttpError(403, "insufficient_scope", `credential lacks scope ${scope}`);
    return principal;
  }

  function validateCreate(body: Record<string, unknown>, merchant: Merchant): PaymentRequest {
    if (typeof body.amountUsd !== "string" || !/^\d{1,9}(\.\d{1,2})?$/.test(body.amountUsd))
      throw new HttpError(400, "invalid_amount", "amountUsd must be a USD decimal string with at most 2 decimals");
    const cents = parseUnits(body.amountUsd, "usd");
    if (cents < 1n) throw new HttpError(400, "invalid_amount", "amountUsd must be at least 0.01");
    if (cents > maxAmountCents)
      throw new HttpError(400, "amount_too_large", `amountUsd exceeds the per-payment limit of ${config.maxAmountUsd}`);
    if (body.payoutChain !== undefined && body.payoutChain !== "base")
      throw new HttpError(400, "unsupported_chain", "payoutChain must be 'base'");
    if (!merchant.baseRecipient)
      throw new HttpError(409, "payout_address_unverified", "verify a Base payout address before creating payments");
    let recipient = merchant.baseRecipient;
    if (body.recipient !== undefined) {
      if (typeof body.recipient !== "string" || !isAddress(body.recipient))
        throw new HttpError(400, "invalid_recipient", "recipient must be a valid Base address");
      if (getAddress(body.recipient) !== getAddress(merchant.baseRecipient))
        throw new HttpError(
          403,
          "recipient_not_verified",
          "recipient must be the merchant's verified Base payout address",
        );
      recipient = getAddress(body.recipient);
    }
    let metadata: Record<string, string> | undefined;
    if (body.metadata !== undefined) {
      if (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata))
        throw new HttpError(400, "invalid_metadata", "metadata must be an object of strings");
      const entries = Object.entries(body.metadata as Record<string, unknown>);
      if (entries.length > 20) throw new HttpError(400, "invalid_metadata", "at most 20 metadata keys");
      for (const [k, v] of entries) {
        if (k.length > 40 || !/^[\w.-]+$/.test(k)) throw new HttpError(400, "invalid_metadata", `invalid metadata key ${k}`);
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
          throw new HttpError(400, "invalid_metadata", "metadata values must be strings");
        if (String(v).length > 500) throw new HttpError(400, "invalid_metadata", "metadata value too long");
      }
      metadata = Object.fromEntries(entries.map(([k, v]) => [k, String(v)]));
    }
    let description: string | undefined;
    if (body.description !== undefined) {
      if (typeof body.description !== "string" || body.description.length > 200)
        throw new HttpError(400, "invalid_description", "description must be a string of at most 200 characters");
      description = body.description;
    }
    return { amountUsd: body.amountUsd, payoutChain: "base", recipient, metadata, description };
  }

  function idempotencyKeyOf(req: IncomingMessage, body: Record<string, unknown>): string | undefined {
    const raw = (req.headers["idempotency-key"] as string | undefined) ?? (body.idempotencyKey as string | undefined);
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 255 || !/^[\x21-\x7e]+$/.test(raw))
      throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 1-255 visible ASCII characters");
    return raw;
  }

  function loadOwnedPayment(principal: Principal, id: string): Payment {
    if (!/^pay_[0-9a-f]{26}$/.test(id)) throw new HttpError(404, "not_found", "payment not found");
    store.expireDue(clock());
    const p = store.getPayment(id);
    if (!p || p.merchantId !== principal.merchant.id) throw new HttpError(404, "not_found", "payment not found");
    return p;
  }

  function siweOrigin(body: Record<string, unknown>) {
    const domain = typeof body.domain === "string" ? body.domain : "";
    const uri = typeof body.uri === "string" ? body.uri : "";
    const chainId = Number(body.chainId ?? 8453);
    return { domain, uri, chainId };
  }

  // ---- routes ----
  const watcherHealth = () =>
    bridge ? bridge.health(config.monitor?.maxSnapshotAgeSeconds) : feed ? feed.health(config.monitor?.maxSnapshotAgeSeconds) : null;

  async function route(req: IncomingMessage, res: ServerResponse, viaOperatorListener = false): Promise<void> {
    const url = new URL(req.url ?? "/", "http://zecone.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const seg = path.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    const now = clock();

    // Public, CORS-readable endpoints.
    const publicCors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS" };
    if (method === "OPTIONS") {
      if (path.startsWith("/api/v1/checkout/") || path === "/api/v1/quote/preview" || path === "/api/v1/health") {
        res.writeHead(204, { ...publicCors, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" });
      } else res.writeHead(204);
      return void res.end();
    }

    if (path === "/api/v1/health" && method === "GET") {
      return send(
        res,
        200,
        {
          status: "ok",
          // Identity so operators/scripts can tell this service (and its version) apart
          // from anything else listening on the port.
          service: "zecone-payments",
          apiVersion: 2,
          pid: process.pid,
          mode: MODE,
          livePayoutEnabled: false,
          zcashBroadcastEnabled: false,
          settlement: feed ? "operator-approved" : "disabled",
          realPayments: feed ? "restricted-pilot" : MODE === "monitor" ? "monitor-only" : "none",
          network: "zcash-mainnet",
          payoutChain: "base",
          attribution: MODE === "monitor" ? "single-active-checkout" : "none-simulated",
          demoObserver: (MODE === "demo" || !!config.demoMerchant) && config.demoObserver.enabled,
          watcher: watcherHealth(),
          now,
        },
        publicCors,
      );
    }

    if (path === "/api/v1/quote/preview" && method === "GET") {
      if (!rateLimit(`ip:${clientKey(req)}:quote`, 60, 2)) throw new HttpError(429, "rate_limited", "too many requests");
      const amountUsd = url.searchParams.get("amountUsd") ?? "";
      if (!/^\d{1,9}(\.\d{1,2})?$/.test(amountUsd)) throw new HttpError(400, "invalid_amount", "amountUsd must be a USD decimal");
      const cents = parseUnits(amountUsd, "usd");
      if (cents < 1n || cents > maxAmountCents) throw new HttpError(400, "invalid_amount", "amount out of range");
      const q = demoQuoteEngine.quote({ amountUsd, payoutChain: "base", now });
      return send(
        res,
        200,
        {
          preview: true,
          mode: MODE,
          rateSource: q.rateSource,
          amountUsd: q.amountUsd,
          zecAmount: q.zecAmount,
          ethPayout: q.ethPayout,
          feeZat: q.feeZat,
          validForSeconds: config.quoteTtlSeconds,
          note: "Demo quote at a fixed, labeled rate. Not a live market price.",
        },
        publicCors,
      );
    }

    if (seg[0] === "api" && seg[1] === "v1" && seg[2] === "checkout" && seg[3] && seg[4] === "events" && seg.length === 5 && method === "GET") {
      // Server-sent events for the customer-facing checkout (same token capability).
      if (!rateLimit(`ip:${clientKey(req)}:checkout-sse`, 30, 0.5)) throw new HttpError(429, "rate_limited", "too many requests");
      const id = seg[3];
      const token = url.searchParams.get("token") ?? url.searchParams.get("t");
      if (!/^pay_[0-9a-f]{26}$/.test(id) || !checkoutTokenValid(id, token))
        throw new HttpError(404, "not_found", "checkout not found", undefined, publicCors);
      if (!store.getPayment(id)) throw new HttpError(404, "not_found", "checkout not found", undefined, publicCors);
      res.writeHead(200, { ...publicCors, "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      let last = "";
      let beats = 0;
      const push = () => {
        const p = store.getPayment(id);
        if (!p) return;
        const view = checkoutView(p);
        const sig = `${view.state}:${view.updatedAt}:${view.confirmations ?? ""}`;
        if (sig !== last) {
          last = sig;
          res.write(`event: checkout\ndata: ${JSON.stringify(view)}\n\n`);
        } else if (++beats % 15 === 0) res.write(`: heartbeat\n\n`);
        if (["COMPLETED", "EXPIRED", "FAILED"].includes(view.state)) {
          clearInterval(timer);
          res.end();
        }
      };
      const timer = setInterval(push, 1000);
      push();
      req.on("close", () => clearInterval(timer));
      return;
    }

    if (seg[0] === "api" && seg[1] === "v1" && seg[2] === "checkout" && seg[3] && seg.length === 4 && method === "GET") {
      if (!rateLimit(`ip:${clientKey(req)}:checkout`, 240, 4)) throw new HttpError(429, "rate_limited", "too many requests");
      const id = seg[3];
      const token = url.searchParams.get("token") ?? url.searchParams.get("t");
      if (!/^pay_[0-9a-f]{26}$/.test(id) || !checkoutTokenValid(id, token))
        throw new HttpError(404, "not_found", "checkout not found", undefined, publicCors);
      store.expireDue(now);
      const p = store.getPayment(id);
      if (!p) throw new HttpError(404, "not_found", "checkout not found", undefined, publicCors);
      return send(res, 200, { checkout: checkoutView(p) }, publicCors);
    }

    // ---- merchant onboarding (wallet ownership) ----
    if (path === "/api/v1/merchants/challenge" && method === "POST") {
      if (!rateLimit(`ip:${clientKey(req)}:siwe`, 20, 0.5)) throw new HttpError(429, "rate_limited", "too many requests");
      const body = await readBody(req);
      const purpose = body.purpose === "signin" ? "signin" : "register";
      const o = siweOrigin(body);
      const c = createChallenge(store, config.siwe, {
        address: String(body.address ?? ""),
        chainId: o.chainId,
        domain: o.domain,
        uri: o.uri,
        purpose,
        now,
      });
      return send(res, 201, { challenge: c });
    }

    if (path === "/api/v1/merchants/verify" && method === "POST") {
      if (!rateLimit(`ip:${clientKey(req)}:siwe`, 20, 0.5)) throw new HttpError(429, "rate_limited", "too many requests");
      const body = await readBody(req);
      const proof = await verifyChallenge(store, config.siwe, {
        message: body.message as string,
        signature: body.signature as string,
        now,
      });
      if (proof.purpose !== "register" && proof.purpose !== "signin")
        throw new HttpError(400, "challenge_invalid", "challenge purpose is not merchant sign-in");
      const name =
        typeof body.name === "string" && body.name.trim().length > 0 && body.name.length <= 80
          ? body.name.trim()
          : `Merchant ${proof.address.slice(0, 6)}…${proof.address.slice(-4)}`;
      let merchant = store.merchantByOwner(proof.address);
      let apiKey: string | null = null;
      let created = false;
      if (!merchant) {
        if (proof.purpose === "signin") throw new HttpError(404, "not_registered", "no merchant for this wallet; register first");
        const secret = `sk_${randomBytes(24).toString("hex")}`;
        merchant = store.createMerchant({
          name,
          secret,
          scopes: [...DEFAULT_API_SCOPES],
          baseRecipient: proof.address,
          payoutVerification: "siwe",
          ownerAddress: proof.address,
          now,
        });
        apiKey = `${merchant.keyId}_${secret}`;
        created = true;
      }
      const session = store.issueSession(merchant.id, config.sessionTtlSeconds, now);
      return send(res, created ? 201 : 200, {
        created,
        merchant: merchantView(merchant),
        apiKey,
        apiKeyNote: apiKey ? "Shown once. Store it server-side (e.g. ZECONE_API_KEY); never ship it to a browser." : null,
        session,
      });
    }

    // ---- operator (loopback + bearer token) ----
    if (seg[0] === "api" && seg[1] === "v1" && seg[2] === "operator") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/, "");
      // A loopback socket is not enough: behind the shared-host Nginx every public
      // request arrives from 127.0.0.1. Forwarded requests are never operator calls.
      const forwarded = req.headers["x-forwarded-for"] !== undefined || req.headers["x-real-ip"] !== undefined;
      const reachable = viaOperatorListener || (!config.operatorListenerOnly && isLoopback(req) && !forwarded);
      if (!config.operatorToken || !reachable || token.length !== config.operatorToken.length ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(config.operatorToken)))
        throw new HttpError(404, "not_found", "unknown endpoint");
      if (seg[3] === "demo-replay" && seg[4] && method === "POST") {
        const p = store.getPayment(seg[4]);
        if (!p || p.mode !== "demo") throw new HttpError(404, "not_found", "demo payment not found");
        const final = replayToCompletion(store, p.id, now);
        return send(res, 200, {
          payment: final ? merchantPayment(final) : null,
          demo: true,
          note: "recorded mainnet evidence replayed; no new funds moved",
        });
      }
      if (seg[3] === "unattributed" && method === "GET") return send(res, 200, { deposits: store.listUnattributed() });
      if (seg[3] === "watcher" && seg.length === 4 && method === "POST" && bridge)
        return send(res, 200, { result: await bridge.tick(), health: bridge.health() });
      if (feed) {
        try {
          if (seg[3] === "quote" && seg.length === 4 && method === "POST") {
            if (!(config.pilot?.quoteEngine instanceof OperatorPilotQuoteEngine))
              throw new HttpError(409, "pilot_quote_adapter_unavailable", "signed pilot quote adapter is unavailable");
            const accepted = config.pilot.quoteEngine.accept((await readBody(req)) as never, now);
            return send(res, 200, { accepted });
          }
          if (seg[3] === "watcher" && seg[4] === "heartbeat" && method === "POST")
            return send(res, 200, { health: feed.heartbeat((await readBody(req)) as never) });
          if (seg[3] === "real-orders" && seg.length === 4 && method === "GET")
            return send(res, 200, { orders: feed.realOrders() });
          if (seg[3] === "real-orders" && seg[4] && seg[5] === "observation" && method === "POST")
            return send(res, 200, { payment: merchantPayment(feed.observe(seg[4], await readBody(req))) });
          if (seg[3] === "real-orders" && seg[4] && seg[5] === "payout" && method === "POST")
            return send(res, 200, { payment: merchantPayment(await feed.payout(seg[4], await readBody(req))) });
        } catch (e) {
          if (e instanceof OperatorFeedError) throw new HttpError(e.status, e.code.toLowerCase(), e.code);
          if (e instanceof PilotQuoteError) throw new HttpError(400, e.message.toLowerCase(), e.message);
          throw e;
        }
      }
      throw new HttpError(404, "not_found", "unknown endpoint");
    }

    // ---- authenticated merchant surface ----
    if (path === "/api/v1/merchant" && method === "GET") {
      const pr = authenticate(req);
      return send(res, 200, {
        merchant: merchantView(pr.merchant),
        credential: pr.credential,
        counts: store.countPayments(pr.merchant.id),
      });
    }

    if (path === "/api/v1/merchant/logout" && method === "POST") {
      const pr = authenticate(req, undefined, true);
      store.revokeSession((req.headers.authorization ?? "").slice(7).trim(), now);
      return send(res, 200, { ok: true, merchantId: pr.merchant.id });
    }

    if (path === "/api/v1/merchant/keys" && method === "POST") {
      const pr = authenticate(req, "merchant:manage", true);
      const body = await readBody(req);
      const issued = store.issueApiKey(pr.merchant.id, [...DEFAULT_API_SCOPES], now);
      const revoked = body.revokeOthers === true ? store.revokeApiKeys(pr.merchant.id, issued.keyId, now) : 0;
      return send(res, 201, { apiKey: issued.apiKey, keyId: issued.keyId, revoked, note: "Shown once." });
    }

    if (path === "/api/v1/merchant/payout-address/challenge" && method === "POST") {
      const pr = authenticate(req, "merchant:manage", true);
      const body = await readBody(req);
      const o = siweOrigin(body);
      const c = createChallenge(store, config.siwe, {
        address: String(body.address ?? ""),
        chainId: o.chainId,
        domain: o.domain,
        uri: o.uri,
        purpose: `payout:${pr.merchant.id}`,
        now,
      });
      return send(res, 201, { challenge: c });
    }

    if (path === "/api/v1/merchant/payout-address" && method === "POST") {
      const pr = authenticate(req, "merchant:manage", true);
      const body = await readBody(req);
      const proof = await verifyChallenge(store, config.siwe, {
        message: body.message as string,
        signature: body.signature as string,
        expectedPurpose: `payout:${pr.merchant.id}`,
        now,
      });
      store.setPayoutAddress(pr.merchant.id, proof.address, "siwe");
      return send(res, 200, { merchant: merchantView(store.getMerchant(pr.merchant.id)!) });
    }

    // ---- webhooks ----
    if (path === "/api/v1/webhooks") {
      if (method === "POST") {
        const pr = authenticate(req, "webhooks:manage");
        const body = await readBody(req);
        const url = validateWebhookUrl(body.url, { allowLoopbackHttp: config.allowLoopbackHttpWebhooks });
        if (!url)
          throw new HttpError(
            400,
            "invalid_webhook",
            config.allowLoopbackHttpWebhooks
              ? "url must be https (or http on loopback for local development)"
              : "url must be an https URL",
          );
        const secret = `whsec_${randomBytes(24).toString("hex")}`;
        store.setWebhook(pr.merchant.id, url, secret);
        return send(res, 201, {
          webhook: { url, secret },
          note: "The signing secret is shown once. Store it server-side to verify X-ZecOne-Signature.",
        });
      }
      if (method === "GET") {
        const pr = authenticate(req, "webhooks:manage");
        return send(res, 200, {
          webhook: { url: pr.merchant.webhookUrl, configured: !!pr.merchant.webhookSecret },
          deliveries: store.listDeliveries(pr.merchant.id, 25),
        });
      }
      if (method === "DELETE") {
        const pr = authenticate(req, "webhooks:manage");
        store.setWebhook(pr.merchant.id, null, null);
        return send(res, 200, { ok: true });
      }
    }

    if (path === "/api/v1/webhooks/test" && method === "POST") {
      const pr = authenticate(req, "webhooks:manage");
      const wh = store.merchantWebhook(pr.merchant.id);
      if (!wh) throw new HttpError(409, "webhook_not_configured", "register a webhook URL first");
      const id = store.enqueueWebhook("ping", pr.merchant.id, "webhook.ping", wh.url, now);
      const d = store.getDelivery(id)!;
      const outcome = await dispatcher.deliver(d, now);
      return send(res, 200, { delivery: store.getDelivery(id), outcome });
    }

    // ---- payments ----
    if (path === "/api/v1/payments" && method === "GET") {
      const pr = authenticate(req, "payments:read");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
      const state = url.searchParams.get("state") ?? undefined;
      store.expireDue(now);
      const payments = store.listPayments(pr.merchant.id, limit, offset, state as PaymentState | undefined);
      return send(res, 200, { object: "list", payments: payments.map(merchantPayment), limit, offset });
    }

    if (path === "/api/v1/payments" && method === "POST") {
      const pr = authenticate(req, "payments:create");
      const body = await readBody(req);
      const request = validateCreate(body, pr.merchant);
      // Per-payment mode. With a restricted pilot, only the approved merchant (SIWE-verified
      // payout = owner) gets real orders; the demo storefront stays simulated; others are refused.
      let paymentMode: "demo" | "monitor" = MODE;
      if (MODE === "monitor" && config.pilot) {
        const m = pr.merchant;
        const owner = getAddress(config.pilot.merchantOwner);
        if (m.keyId === DEMO_KEY_ID && config.demoMerchant) paymentMode = "demo";
        else if (
          m.ownerAddress && getAddress(m.ownerAddress) === owner &&
          m.baseRecipient && getAddress(m.baseRecipient) === owner && m.payoutVerification === "siwe"
        ) {
          if (parseUnits(request.amountUsd, "usd") > pilotCents!)
            throw new HttpError(400, "amount_too_large", `real payments are limited to ${config.pilot.maxAmountUsd} USD during the restricted pilot`);
        } else throw new HttpError(403, "real_payments_restricted", "Real mainnet payments are currently limited to one approved pilot merchant.");
      }
      const idempotencyKey = idempotencyKeyOf(req, body);
      const result = store.tx(() => {
        const { payment, created } = store.createPayment({
          merchantId: pr.merchant.id,
          request,
          mode: paymentMode,
          idempotencyKey,
          now,
        });
        if (!created) return { payment, created };
        // Read-only monitor mode retains its synthetic attribution fixture. Only
        // the restricted pilot can create an economically actionable real order,
        // and that path must use the verified live authority.
        const engine = paymentMode === "demo" || !config.pilot ? demoQuoteEngine : config.pilot.quoteEngine;
        if (!engine) throw new HttpError(503, "live_quote_unavailable", "Verified live pricing is unavailable; real checkouts are paused.");
        const quote = { ...engine.quote({ amountUsd: request.amountUsd, payoutChain: "base", recipient: request.recipient, now }) };
        if (
          paymentMode !== "demo" && !!config.pilot &&
          (!engine.enabled || !validLiveQuote(quote, request.amountUsd, now))
        )
          throw new HttpError(503, "live_quote_invalid", "The live pricing authority returned an invalid or stale quote; real checkouts are paused.");
        // Liquidity guard: real (monitor) checkouts promise a payout the relayer must be able
        // to cover. Simulated demo checkouts promise nothing, so they are not counted.
        if (paymentMode !== "demo") assertLiquidity(store, paymentMode, BigInt(quote.ethPayoutWei), config.relayerAvailableWei);
        if (paymentMode === "demo") {
          // Simulated checkout: no payable address, no allocation, no payment URI.
          store.setQuote(payment.id, quote, null, quote.expiresAt, now);
        } else {
          // Real address: only with a fresh watcher checkpoint, so notes mined before
          // this checkout (height <= allocation tip) can never be attributed to it.
          const health = watcherHealth()!;
          if (!health.ready || health.tip === null)
            throw new HttpError(503, "watcher_not_ready", "The mainnet watcher has no fresh verified snapshot; real checkouts are paused.");
          // A new order never allocates at or below a previous order's inclusion height,
          // so a delayed deposit for that order can never be claimed by this one.
          const floor = store.inclusionFloor(config.checkoutAddress);
          if (floor !== null && health.tip <= floor)
            throw new HttpError(409, "checkout_busy", "The previous checkout's on-chain payment window has not closed yet.", {
              retryAfter: (floor - health.tip + 1) * 75,
            });
          let window: ReturnType<typeof paymentWindow>;
          try {
            window = paymentWindow({
              now,
              paymentDeadline: quote.expiresAt,
              tip: health.tip,
              tipObservedAt: health.observedAt ?? now,
              observationGraceSeconds: config.observationGraceSeconds ?? DEFAULT_OBSERVATION_GRACE_SECONDS,
            });
          } catch (e) {
            if (e instanceof PaymentWindowError)
              throw new HttpError(503, "watcher_not_ready", "The verified watcher tip is too old to bound this payment; real checkouts are paused.");
            throw e;
          }
          store.setQuote(payment.id, quote, config.checkoutAddress, quote.expiresAt, now, {
            exclusive: config.exclusiveAllocation,
            allocationTip: health.tip,
            window,
          });
        }
        return { payment: store.getPayment(payment.id)!, created };
      });
      if (!result.created) return send(res, 200, { payment: merchantPayment(result.payment), idempotent: true });
      return send(res, 201, { payment: merchantPayment(result.payment) });
    }

    if (seg.length >= 4 && seg[0] === "api" && seg[1] === "v1" && seg[2] === "payments") {
      const id = seg[3];
      const sub = seg[4];
      if (seg.length === 4 && method === "GET") {
        const pr = authenticate(req, "payments:read");
        return send(res, 200, { payment: merchantPayment(loadOwnedPayment(pr, id)) });
      }
      if (sub === "quote" && seg.length === 5 && method === "GET") {
        const pr = authenticate(req, "payments:read");
        const p = loadOwnedPayment(pr, id);
        return send(res, 200, { quote: p.quote, expired: p.quote ? p.quote.expiresAt <= now : null });
      }
      if (sub === "receipt" && seg.length === 5 && method === "GET") {
        const pr = authenticate(req, "payments:read");
        const p = loadOwnedPayment(pr, id);
        if (p.state !== "COMPLETED")
          throw new HttpError(409, "not_completed", `payment is ${p.state}; receipts exist only for COMPLETED payments`);
        return send(res, 200, { receipt: receipt(p) });
      }
      if (sub === "cancel" && seg.length === 5 && method === "POST") {
        const pr = authenticate(req, "payments:cancel");
        const p = loadOwnedPayment(pr, id);
        if (!store.cancel(p.id, now)) throw new HttpError(409, "not_cancelable", `payment is ${p.state}`);
        return send(res, 200, { payment: merchantPayment(store.getPayment(p.id)!) });
      }
      if (sub === "events" && seg.length === 5 && method === "GET") {
        const pr = authenticate(req, "payments:read");
        const p = loadOwnedPayment(pr, id);
        const events = store.listEvents(p.id);
        if (url.searchParams.get("stream") === "1") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
          let last = 0;
          const flush = () => {
            for (const e of store.listEvents(p.id)) {
              if (e.id <= last) continue;
              last = e.id;
              res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
            }
          };
          flush();
          const timer = setInterval(() => {
            flush();
            res.write(`: heartbeat\n\n`);
          }, 2000);
          req.on("close", () => clearInterval(timer));
          return;
        }
        return send(res, 200, { events });
      }
      throw new HttpError(404, "not_found", "unknown endpoint");
    }

    throw new HttpError(404, "not_found", "unknown endpoint");
  }

  async function handle(req: IncomingMessage, res: ServerResponse, viaOperatorListener = false): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("X-Request-Id", randomBytes(8).toString("hex"));
    try {
      await route(req, res, viaOperatorListener);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const err = toHttpError(e);
      if (err.status >= 500 && !(e instanceof HttpError) && !(e instanceof PilotQuoteError))
        console.error("[payments] handler error:", e);
      const body: ApiError = { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
      send(res, err.status, body, err.headers);
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let watchTimer: NodeJS.Timeout | null = null;
  async function tick() {
    const now = clock();
    store.expireDue(now);
    // Demo payments replay recorded evidence; with a restricted pilot they share the API with real orders.
    if ((MODE === "demo" || config.demoMerchant) && config.demoObserver.enabled) observer.tick(now);
    await dispatcher.drain(now);
  }

  return {
    handle: (req, res) => handle(req, res, false),
    handleOperator: (req, res) => handle(req, res, true),
    feed,
    store,
    dispatcher,
    observer,
    bridge,
    tick,
    demoApiKey,
    checkoutToken,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick().catch((e) => console.error("[payments] maintenance error:", e)), 1000);
      timer.unref();
      if (bridge && config.monitor) {
        const run = () =>
          void bridge.tick().then((r) => {
            if (!r.ok && r.error !== "WATCH_WORKER_LOCKED") console.error(`[payments] watcher: ${r.error}`);
          });
        run();
        watchTimer = setInterval(run, config.monitor.intervalSeconds * 1000);
        watchTimer.unref();
      }
    },
    close() {
      if (timer) clearInterval(timer);
      if (watchTimer) clearInterval(watchTimer);
      timer = null;
      watchTimer = null;
      store.close();
    },
  };
}

function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof StoreError) {
    const status = e.code === "not_found" ? 404 : 409;
    const headers: Record<string, string> = {};
    if (e.code === "checkout_busy" && e.details?.retryAfter) headers["Retry-After"] = String(e.details.retryAfter);
    const messages: Record<string, string> = {
      checkout_busy:
        "Another checkout is active on the shared receiving address. ZecOne attributes shielded payments with a single active checkout per address; retry after it completes or expires.",
    };
    return new HttpError(status, e.code, messages[e.code] ?? e.message, e.details, headers);
  }
  if (e instanceof SiweError) {
    const status = e.code === "signature_invalid" || e.code === "message_mismatch" ? 401 : 400;
    return new HttpError(status, e.code, e.message);
  }
  if (e instanceof InsufficientLiquidityError)
    return new HttpError(409, "insufficient_liquidity", "The relayer cannot cover this payout right now. Try a smaller amount later.");
  if (e instanceof PilotQuoteError)
    return new HttpError(503, "live_quote_unavailable", e.message);
  if (e instanceof MoneyError) return new HttpError(400, e.code, e.message);
  return new HttpError(500, "internal", "internal error");
}

/** Build a config from environment variables (demo-safe defaults). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentsConfig {
  const mode = (env.ZECONE_PAYMENTS_MODE ?? "demo") as
    | "demo"
    | "monitor"
    | "live";
  const allowed = (env.ZECONE_SIWE_DOMAINS ?? "localhost:3000,127.0.0.1:3000,localhost:4333,127.0.0.1:4333")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const demoSecret = env.ZECONE_DEMO_SECRET ?? "demo-merchant-secret-change-me";
  const publicUrl = env.ZECONE_PUBLIC_URL ?? "http://localhost:3000";
  const production = env.NODE_ENV === "production";
  if (production) {
    if (!publicUrl.startsWith("https://"))
      throw new Error("ZECONE_PUBLIC_URL must use HTTPS in production");
    if (env.ZECONE_ALLOW_HTTP_WEBHOOKS !== "0")
      throw new Error("ZECONE_ALLOW_HTTP_WEBHOOKS must be 0 in production");
    if (mode === "demo" && (
      demoSecret === "demo-merchant-secret-change-me" ||
      demoSecret.length < 32
    ))
      throw new Error(
        "ZECONE_DEMO_SECRET must be a non-default 32+ character secret in production",
      );
    if (mode === "demo" && env.ZECONE_OPERATOR_TOKEN)
      throw new Error("ZECONE_OPERATOR_TOKEN must be empty in demo production");
  }
  if (mode === "monitor" && !env.ZECONE_CHECKOUT_ADDRESS)
    throw new Error("ZECONE_CHECKOUT_ADDRESS is required in monitor mode");
  const relayer = env.ZECONE_RELAYER_AVAILABLE_WEI ?? "50000000000000000"; // 0.05 ETH demo snapshot
  if (!/^\d+$/.test(relayer)) throw new Error("ZECONE_RELAYER_AVAILABLE_WEI must be an integer wei amount");
  // Restricted mainnet pilot: real orders for one approved merchant, fed by the operator watcher.
  let pilot: PaymentsConfig["pilot"] = null;
  if (mode === "monitor" && env.ZECONE_PILOT_MERCHANT_OWNER) {
    const owner = env.ZECONE_PILOT_MERCHANT_OWNER;
    const relayerAddress = env.ZECONE_RELAYER_ADDRESS ?? "";
    const maxPayout = env.ZECONE_PILOT_MAX_PAYOUT_WEI ?? "";
    const authority = env.ZECONE_PILOT_QUOTE_AUTHORITY ?? "";
    const publicKey = env.ZECONE_PILOT_QUOTE_PUBLIC_KEY_B64 ?? "";
    if (!isAddress(owner) || !isAddress(relayerAddress))
      throw new Error("ZECONE_PILOT_MERCHANT_OWNER and ZECONE_RELAYER_ADDRESS must be Base addresses");
    if (!/^[1-9]\d{0,20}$/.test(maxPayout))
      throw new Error("ZECONE_PILOT_MAX_PAYOUT_WEI must be a positive integer wei amount");
    const maxAmountUsd = env.ZECONE_PILOT_MAX_AMOUNT_USD ?? "0.01";
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(maxAmountUsd))
      throw new Error("ZECONE_PILOT_MAX_AMOUNT_USD must be a small USD amount");
    if (!authority || !publicKey) throw new Error("PILOT_LIVE_QUOTE_AUTHORITY_NOT_CONFIGURED");
    let publicDer: Buffer;
    try {
      publicDer = Buffer.from(publicKey, "base64");
      if (publicDer.length < 32) throw Error();
    } catch {
      throw new Error("ZECONE_PILOT_QUOTE_PUBLIC_KEY_B64_INVALID");
    }
    const quoteTtlSeconds = Number(env.ZECONE_QUOTE_TTL_SECONDS ?? 300);
    pilot = {
      merchantOwner: getAddress(owner),
      maxAmountUsd,
      maxPayoutWei: BigInt(maxPayout),
      payout: basePayoutCheck(
        (env.ZECONE_BASE_PAYOUT_RPCS ?? "").split(",").map((u) => u.trim()).filter(Boolean),
        getAddress(relayerAddress),
      ),
      quoteEngine: new OperatorPilotQuoteEngine({
        authority,
        publicKey: publicDer,
        recipient: getAddress(owner),
        ttlSeconds: quoteTtlSeconds,
        maximumSpreadBps: 200,
      }),
    };
  }
  return {
    dbPath: env.ZECONE_PAYMENTS_DB ?? ".state/payments.sqlite",
    checkoutAddress:
      mode === "demo"
        ? "demo:no-payable-address"
        : (env.ZECONE_CHECKOUT_ADDRESS ?? DEFAULT_CHECKOUT_ADDRESS),
    mode,
    demoMerchant:
      env.ZECONE_DEMO_MERCHANT === "0" || (mode === "monitor" && !pilot)
        ? null
        : { secret: demoSecret, payoutAddress: env.ZECONE_DEMO_PAYOUT_ADDRESS ?? BASE_RECIPIENT_DEFAULT },
    siwe: { allowedDomains: allowed, ttlSeconds: 600, baseRpcUrl: env.ZECONE_BASE_RPC_URL || undefined },
    publicCheckoutBaseUrl: publicUrl,
    operatorToken: env.ZECONE_OPERATOR_TOKEN || null,
    pilot,
    operatorListenerOnly: !!pilot,
    exclusiveAllocation: env.ZECONE_EXCLUSIVE_ALLOCATION !== "0",
    quoteTtlSeconds: Number(env.ZECONE_QUOTE_TTL_SECONDS ?? 900),
    observationGraceSeconds: Number(env.ZECONE_OBSERVATION_GRACE_SECONDS ?? DEFAULT_OBSERVATION_GRACE_SECONDS),
    maxAmountUsd: env.ZECONE_MAX_AMOUNT_USD ?? "500.00",
    relayerAvailableWei: BigInt(relayer),
    demoObserver: {
      enabled: env.ZECONE_DEMO_OBSERVER !== "0",
      startAfterSeconds: Number(env.ZECONE_DEMO_OBSERVER_DELAY ?? 12),
      stepSeconds: Number(env.ZECONE_DEMO_OBSERVER_STEP ?? 2),
    },
    allowLoopbackHttpWebhooks: env.ZECONE_ALLOW_HTTP_WEBHOOKS !== "0",
    sessionTtlSeconds: Number(env.ZECONE_SESSION_TTL_SECONDS ?? 8 * 3600),
    trustedProxy: env.ZECONE_TRUST_PROXY === "1",
  };
}
