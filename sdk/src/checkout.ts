// @zecone/sdk/checkout: browser-safe helpers for the customer-facing checkout.
//
// Uses only the payment id and its read-only checkout token. No API key, no
// signing, no ability to change a payment. A "completed" status seen here is a
// UI hint: merchants must still confirm settlement server-side (signed webhook
// or `zecone.payments.retrieve`) before granting anything of value.
import qrcode from "qrcode-generator";
import type { CheckoutView, PaymentState } from "./types.ts";
import { ZecOneError } from "./types.ts";

export type { CheckoutView, PaymentState } from "./types.ts";

export type CheckoutPhase = "loading" | "awaiting" | "processing" | "completed" | "expired" | "failed" | "review" | "error";

export const CHECKOUT_STEPS: { key: string; label: string; states: PaymentState[] }[] = [
  { key: "request", label: "Payment request created", states: ["CREATED", "QUOTED", "AWAITING_PAYMENT"] },
  { key: "detected", label: "Shielded payment detected", states: ["PAYMENT_DETECTED", "VERIFYING"] },
  { key: "confirmed", label: "ZEC confirmed", states: ["ZEC_CONFIRMED"] },
  { key: "payout", label: "ETH payout on Base", states: ["PAYOUT_PENDING", "PAYOUT_SUBMITTED", "PAYOUT_CONFIRMED"] },
  { key: "done", label: "Completed", states: ["COMPLETED"] },
];

/** Index of the step currently in progress (or completed) for a state. */
export function stepIndex(state: PaymentState): number {
  const i = CHECKOUT_STEPS.findIndex((s) => s.states.includes(state));
  return i < 0 ? 0 : i;
}

export function phaseOf(state: PaymentState | null): CheckoutPhase {
  if (state === null) return "loading";
  if (state === "COMPLETED") return "completed";
  if (state === "EXPIRED") return "expired";
  if (state === "FAILED") return "failed";
  if (state === "MANUAL_REVIEW") return "review";
  if (state === "AWAITING_PAYMENT" || state === "CREATED" || state === "QUOTED") return "awaiting";
  return "processing";
}

export async function fetchCheckout(
  apiBaseUrl: string,
  paymentId: string,
  checkoutToken: string,
  init: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<CheckoutView> {
  const f = init.fetch ?? fetch;
  const url = `${apiBaseUrl.replace(/\/+$/, "")}/api/v1/checkout/${encodeURIComponent(paymentId)}?token=${encodeURIComponent(checkoutToken)}`;
  let res: Response;
  try {
    res = await f(url, { signal: init.signal, headers: { Accept: "application/json" } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ZecOneError("could not reach ZecOne", "network", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { checkout?: CheckoutView; error?: { code: string; message: string } };
  if (!res.ok || !data.checkout)
    throw new ZecOneError(data.error?.message ?? `HTTP ${res.status}`, data.error?.code ?? "http_error", res.status);
  return data.checkout;
}

/**
 * Follow a checkout until it reaches a terminal state. Returns a stop function.
 * Uses server-sent events when the browser supports them (`transport: "auto"`),
 * falling back to polling if the stream fails. `onUpdate` fires on every change.
 */
export function watchCheckout(
  apiBaseUrl: string,
  paymentId: string,
  checkoutToken: string,
  handlers: {
    onUpdate: (c: CheckoutView) => void;
    onError?: (e: ZecOneError) => void;
    intervalMs?: number;
    transport?: "auto" | "poll";
  },
): () => void {
  let stopped = false;
  let last: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let source: { close(): void } | null = null;
  const controller = new AbortController();
  const terminal = (c: CheckoutView) => ["COMPLETED", "EXPIRED", "FAILED"].includes(c?.state);
  const deliver = (c: CheckoutView) => {
    // Shape checks belong to presentCheckout(); this only drops non-objects.
    if (!c || typeof c !== "object") return;
    const sig = `${c.state}:${c.updatedAt}:${c.confirmations ?? ""}`;
    if (sig !== last) {
      last = sig;
      handlers.onUpdate(c);
    }
  };
  const loop = async () => {
    if (stopped) return;
    try {
      const c = await fetchCheckout(apiBaseUrl, paymentId, checkoutToken, { signal: controller.signal });
      deliver(c);
      if (terminal(c)) return;
    } catch (e) {
      if (stopped) return;
      // Re-deliver the next good view even if unchanged, so a UI that hid details on error can recover.
      last = null;
      handlers.onError?.(e instanceof ZecOneError ? e : new ZecOneError(String(e), "network", 0));
    }
    timer = setTimeout(loop, handlers.intervalMs ?? 2000);
  };
  const ES = (globalThis as { EventSource?: new (url: string) => {
    addEventListener(t: string, f: (e: { data: string }) => void): void;
    onerror: (() => void) | null;
    close(): void;
  } }).EventSource;
  if (ES && handlers.transport !== "poll") {
    const url = `${apiBaseUrl.replace(/\/+$/, "")}/api/v1/checkout/${encodeURIComponent(paymentId)}/events?token=${encodeURIComponent(checkoutToken)}`;
    const es = new ES(url);
    source = es;
    let opened = false;
    // Some proxies buffer event streams. If nothing arrives quickly, poll instead.
    timer = setTimeout(() => {
      if (opened || stopped) return;
      es.close();
      source = null;
      void loop();
    }, 3000);
    es.addEventListener("checkout", (e) => {
      if (!opened && timer) clearTimeout(timer);
      opened = true;
      let c: CheckoutView;
      try {
        c = JSON.parse(e.data) as CheckoutView;
      } catch {
        return; // malformed event: ignore it rather than crash the checkout
      }
      deliver(c);
      if (terminal(c)) es.close();
    });
    es.onerror = () => {
      if (source !== es) return;
      if (timer) clearTimeout(timer);
      es.close();
      source = null;
      // Stream unavailable (proxy, old server) or ended: fall back to polling.
      if (!stopped && (!opened || last === null || !last.startsWith("COMPLETED"))) void loop();
    };
  } else {
    void loop();
  }
  return () => {
    stopped = true;
    controller.abort();
    source?.close();
    if (timer) clearTimeout(timer);
  };
}

/** Render a ZIP-321 payment URI (or any text) as a compact SVG path. */
export function qrSvg(text: string, opts: { margin?: number } = {}): { size: number; path: string } {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const m = opts.margin ?? 2;
  let path = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${c + m} ${r + m}h1v1h-1z`;
    }
  }
  return { size: n + m * 2, path };
}

export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Presentation: what the customer is allowed to see for a checkout.
//
// Every checkout view is untrusted input (it crosses a proxy and the network).
// presentCheckout() validates it and derives exactly one labelled status. It
// fails closed: a payable address/QR appears only for a real, unexpired,
// self-consistent payment request from a verified-fresh view, and "COMPLETED"
// appears only with a finalized Base receipt reported by the backend. Nothing
// here can change a payment.
// ---------------------------------------------------------------------------

export type CheckoutMode = "simulated" | "mainnet" | "live" | "unknown";

export type CheckoutStatus =
  | "LOADING"
  | "INVALID_LINK"
  | "UNVERIFIED"
  | "SIMULATED"
  | "SIMULATED_COMPLETE"
  | "OBSERVING"
  | "CONFIRMING"
  | "ZEC_CONFIRMED"
  | "PAYOUT_PENDING"
  | "COMPLETED"
  | "MANUAL_REVIEW"
  | "REORG"
  | "PROVIDER_DISAGREEMENT"
  | "WATCHER_PAUSED"
  | "WINDOW_CLOSED"
  | "EXPIRED"
  | "FAILED";

export type CheckoutTone = "neutral" | "info" | "warning" | "danger" | "success";

export type ModeInfo = { mode: CheckoutMode; modeLabel: string; modeDetail: string };

export interface CheckoutPresentation extends ModeInfo {
  status: CheckoutStatus;
  statusLabel: string;
  statusDetail: string;
  tone: CheckoutTone;
  /** Backward-compatible coarse phase (the `data-zecone-checkout` attribute). */
  phase: CheckoutPhase;
  /** Exact payment request. Only for a real, open, consistent, fresh checkout. */
  payment: {
    address: string;
    zecAmount: string;
    zecAmountZat: string;
    uri: string;
    expiresAt: number;
    secondsLeft: number;
  } | null;
  confirmations: { current: number; required: number } | null;
  /** Finalized Base payout: real on COMPLETED, or the labelled recorded replay in a demo. */
  receipt: { txHash: string; explorerUrl: string; recorded: boolean } | null;
  /** Machine-readable reasons a view was distrusted or details were withheld. */
  issues: string[];
}

/** Optional, forward-compatible fields the backend may add to the public view. */
export type CheckoutViewWire = CheckoutView & {
  /** MANUAL_REVIEW reason code (e.g. "chain_reorganization"). Optional. */
  reviewReason?: string | null;
};

export interface PresentContext {
  /** Server-adjusted unix seconds. */
  now: number;
  /** The payment id the page asked for; a view for any other id is refused. */
  expectedId?: string;
  /** Watcher health from /api/v1/health. `ready: false` pauses real payment requests. */
  watcher?: { ready: boolean } | null;
  /** True when the last verified update is too old (connection lost). */
  stale?: boolean;
}

const STATES: readonly PaymentState[] = [
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
];
const BECH32 = "[qpzry9x8gf2tvdw0s3jn54khce6mua7l]";
const SHIELDED_ADDRESS = new RegExp(`^(u1${BECH32}{60,1000}|zs1${BECH32}{75})$`);
const ZEC_AMOUNT = /^(0|[1-9][0-9]{0,7})(\.[0-9]{1,8})?$/;
const ZAT = /^(0|[1-9][0-9]{0,16})$/;
const BASE_TX = /^0x[0-9a-f]{64}$/;
const PAYMENT_ID = /^pay_[0-9a-f]{26}$/;
const USD = /^[0-9]{1,9}(\.[0-9]{1,2})?$/;
const ZIP321_KEYS = new Set(["amount", "label", "message"]);
const basescan = (hash: string) => `https://basescan.org/tx/${hash}`;

const isInt = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;

/** "0.02" → "2000000". Null if the decimal is not a valid ZEC amount. */
export function zecToZat(amount: string): string | null {
  if (!ZEC_AMOUNT.test(amount)) return null;
  const [w, f = ""] = amount.split(".");
  return (BigInt(w) * 100_000_000n + BigInt(f.padEnd(8, "0"))).toString();
}

/**
 * Parse a single-recipient ZIP-321 URI. Returns null for anything that is not
 * exactly `zcash:<shielded address>[?amount=…&label=…&message=…]`: multi-payment
 * requests, memos, unknown or duplicate parameters are refused.
 */
export function parseZip321(uri: string): { address: string; amount: string | null } | null {
  if (typeof uri !== "string" || !uri.startsWith("zcash:")) return null;
  const rest = uri.slice("zcash:".length);
  const q = rest.indexOf("?");
  const address = q < 0 ? rest : rest.slice(0, q);
  if (!SHIELDED_ADDRESS.test(address)) return null;
  let amount: string | null = null;
  const seen = new Set<string>();
  if (q >= 0) {
    for (const part of rest.slice(q + 1).split("&")) {
      const eq = part.indexOf("=");
      if (eq <= 0) return null;
      const key = part.slice(0, eq);
      if (!ZIP321_KEYS.has(key) || seen.has(key)) return null;
      seen.add(key);
      if (key === "amount") {
        amount = part.slice(eq + 1);
        if (!ZEC_AMOUNT.test(amount)) return null;
      }
    }
  }
  return { address, amount };
}

/** Structural validation of an untrusted checkout view. Returns issue codes (empty = valid). */
export function validateCheckoutView(raw: unknown, expectedId?: string): string[] {
  if (!raw || typeof raw !== "object") return ["not_an_object"];
  const issues: string[] = [];
  const c = raw as Record<string, unknown>;
  if (c.object !== "checkout") issues.push("object");
  if (typeof c.id !== "string" || !PAYMENT_ID.test(c.id)) issues.push("id");
  else if (expectedId && c.id !== expectedId) issues.push("id_mismatch");
  if (!STATES.includes(c.state as PaymentState)) issues.push("state");
  if (c.mode !== "demo" && c.mode !== "monitor" && c.mode !== "live") issues.push("mode");
  if (typeof c.simulated !== "boolean" || c.simulated !== (c.mode === "demo")) issues.push("simulated_mode_mismatch");
  if (c.settlement !== "disabled" && c.settlement !== "operator-approved") issues.push("settlement");
  if (typeof c.amountUsd !== "string" || !USD.test(c.amountUsd)) issues.push("amount_usd");
  const merchant = c.merchant as { name?: unknown } | null;
  if (!merchant || typeof merchant !== "object" || typeof merchant.name !== "string") issues.push("merchant");
  if (!isInt(c.serverTime, 1)) issues.push("server_time");
  if (!isInt(c.updatedAt)) issues.push("updated_at");
  if (c.expiresAt != null && !isInt(c.expiresAt)) issues.push("expires_at");
  if (c.paymentDeadline != null && !isInt(c.paymentDeadline)) issues.push("payment_deadline");
  if (
    c.observationDeadline != null &&
    (!isInt(c.observationDeadline) || (isInt(c.paymentDeadline) && c.observationDeadline <= c.paymentDeadline))
  )
    issues.push("observation_deadline");
  if (c.confirmations != null && !isInt(c.confirmations)) issues.push("confirmations");
  if (c.minimumConfirmations != null && !isInt(c.minimumConfirmations, 1)) issues.push("minimum_confirmations");
  const quote = c.quote as Record<string, unknown> | null | undefined;
  if (quote != null) {
    if (typeof quote !== "object") issues.push("quote");
    else {
      if (typeof quote.zecAmount !== "string" || !ZEC_AMOUNT.test(quote.zecAmount)) issues.push("quote_amount");
      else if (typeof quote.zecAmountZat !== "string" || !ZAT.test(quote.zecAmountZat) || zecToZat(quote.zecAmount) !== quote.zecAmountZat)
        issues.push("quote_zat_mismatch");
      if (!isInt(quote.expiresAt)) issues.push("quote_expiry");
    }
  }
  if (c.simulated === true && (c.zcashAddress != null || c.paymentUri != null)) issues.push("simulated_with_address");
  if (c.payoutTxHash != null && (typeof c.payoutTxHash !== "string" || !BASE_TX.test(c.payoutTxHash))) issues.push("payout_tx");
  return issues;
}

/** One place for status copy so hosted, embedded and SDK checkouts say the same thing. */
export const CHECKOUT_STATUS_COPY: Record<CheckoutStatus, { label: string; detail: string; tone: CheckoutTone }> = {
  LOADING: { label: "LOADING", detail: "Loading checkout…", tone: "neutral" },
  INVALID_LINK: {
    label: "INVALID LINK",
    detail: "This checkout link is invalid or incomplete. Do not send ZEC. Ask the merchant to send the full link again.",
    tone: "danger",
  },
  UNVERIFIED: {
    label: "CANNOT VERIFY",
    detail: "This checkout returned details that failed verification, so no payment details are shown. Do not send ZEC.",
    tone: "danger",
  },
  SIMULATED: { label: "SIMULATED DEMO", detail: "No funds move. There is nothing to pay.", tone: "neutral" },
  SIMULATED_COMPLETE: {
    label: "SIMULATED REPLAY",
    detail: "Simulated payment complete: a replay of recorded mainnet pilot transactions. No funds moved for this checkout.",
    tone: "neutral",
  },
  OBSERVING: { label: "OBSERVING", detail: "Awaiting authenticated watcher evidence of your payment.", tone: "info" },
  CONFIRMING: { label: "CONFIRMING", detail: "Payment seen on Zcash mainnet. Waiting for confirmations.", tone: "info" },
  ZEC_CONFIRMED: {
    label: "ZEC CONFIRMED",
    detail: "ZEC confirmed. Automatic payout is disabled for this checkout; the merchant will follow up.",
    tone: "warning",
  },
  PAYOUT_PENDING: {
    label: "PAYOUT PENDING",
    detail: "ZEC confirmed. The merchant's Base transaction is not finalized yet, so this order is not complete.",
    tone: "info",
  },
  COMPLETED: { label: "COMPLETED", detail: "Payment complete. The Base payout is finalized.", tone: "success" },
  MANUAL_REVIEW: {
    label: "MANUAL REVIEW",
    detail: "Your payment is under manual review. No automatic payout will be made. Do not pay again; the merchant will follow up.",
    tone: "warning",
  },
  REORG: {
    label: "REORG",
    detail: "A Zcash chain reorganization affected this payment. It is held for manual review with no automatic payout. Do not pay again.",
    tone: "danger",
  },
  PROVIDER_DISAGREEMENT: {
    label: "PROVIDER DISAGREEMENT",
    detail: "Independent Zcash providers disagreed about this payment. It is held for manual review with no automatic payout. Do not pay again.",
    tone: "danger",
  },
  WATCHER_PAUSED: {
    label: "WATCHER PAUSED",
    detail: "ZecOne cannot currently verify Zcash mainnet with its independent providers, so payment details are hidden. Do not send ZEC until this clears.",
    tone: "danger",
  },
  WINDOW_CLOSED: {
    label: "PAYMENT WINDOW CLOSED",
    detail: "Payment window closed — checking for a payment mined before the deadline.",
    tone: "info",
  },
  EXPIRED: {
    label: "EXPIRED",
    detail: "This payment request expired. Do not send ZEC to it. Ask the merchant for a new link.",
    tone: "danger",
  },
  FAILED: { label: "FAILED", detail: "This payment failed. The merchant has been notified.", tone: "danger" },
};

function reviewStatus(reason: unknown): CheckoutStatus {
  if (typeof reason !== "string") return "MANUAL_REVIEW";
  if (/reorg/.test(reason)) return "REORG";
  if (/disagree/.test(reason)) return "PROVIDER_DISAGREEMENT";
  return "MANUAL_REVIEW";
}

function phaseFor(status: CheckoutStatus): CheckoutPhase {
  switch (status) {
    case "COMPLETED":
    case "SIMULATED_COMPLETE":
      return "completed";
    case "EXPIRED":
      return "expired";
    case "FAILED":
      return "failed";
    case "MANUAL_REVIEW":
    case "REORG":
    case "PROVIDER_DISAGREEMENT":
      return "review";
    case "WINDOW_CLOSED":
      return "processing";
    case "UNVERIFIED":
    case "INVALID_LINK":
      return "error";
    case "LOADING":
      return "loading";
    case "SIMULATED":
    case "OBSERVING":
    case "WATCHER_PAUSED":
      return "awaiting";
    default:
      return "processing";
  }
}

const UNKNOWN_MODE: ModeInfo = { mode: "unknown", modeLabel: "UNVERIFIED", modeDetail: "The checkout mode could not be verified." };

function modeOf(c: CheckoutView): ModeInfo {
  if (c.simulated) return { mode: "simulated", modeLabel: "SIMULATED DEMO", modeDetail: "No funds move. There is no address and nothing to pay." };
  if (c.mode === "live")
    return { mode: "live", modeLabel: "LIVE SETTLEMENT", modeDetail: "Real ZEC address and amount. Settles to the merchant on Base." };
  return {
    mode: "mainnet",
    modeLabel: "MAINNET PAYMENT",
    modeDetail:
      c.settlement === "operator-approved"
        ? "Real ZEC address and amount. Restricted pilot: only a payment from the pilot's integrated ZecOne wallet before the deadline is eligible for operator-approved settlement."
        : "Real ZEC address and amount. ZecOne observes the payment read-only; automatic payout is off.",
  };
}

/** A presentation for a status with no payment details (used for loading and link errors too). */
export function presentStatus(status: CheckoutStatus, mode: ModeInfo = UNKNOWN_MODE, issues: string[] = []): CheckoutPresentation {
  const copy = CHECKOUT_STATUS_COPY[status];
  return {
    ...mode,
    status,
    statusLabel: copy.label,
    statusDetail: copy.detail,
    tone: copy.tone,
    phase: phaseFor(status),
    payment: null,
    confirmations: null,
    receipt: null,
    issues,
  };
}

/** Derive the single labelled status and exactly the details the customer may see. */
export function presentCheckout(raw: unknown, ctx: PresentContext): CheckoutPresentation {
  const issues = validateCheckoutView(raw, ctx.expectedId);
  if (issues.length) return presentStatus("UNVERIFIED", UNKNOWN_MODE, issues);
  const c = raw as CheckoutViewWire;
  const m = modeOf(c);

  // ---- simulated demo: never an address, never "paid" ----
  if (c.simulated) {
    if (c.state === "COMPLETED") {
      const p = presentStatus("SIMULATED_COMPLETE", m);
      if (c.payoutTxHash && c.payoutExplorerUrl === basescan(c.payoutTxHash))
        p.receipt = { txHash: c.payoutTxHash, explorerUrl: c.payoutExplorerUrl, recorded: true };
      return p;
    }
    if (c.state === "EXPIRED" || c.state === "FAILED" || c.state === "MANUAL_REVIEW") return presentStatus(c.state, m);
    const p = presentStatus("SIMULATED", m);
    if (!["CREATED", "QUOTED", "AWAITING_PAYMENT"].includes(c.state)) p.phase = "processing";
    return p;
  }

  // ---- real (mainnet observation or live) ----
  const confirmations =
    c.confirmations != null && c.minimumConfirmations != null
      ? { current: Math.min(c.confirmations, c.minimumConfirmations), required: c.minimumConfirmations }
      : null;
  const withConf = (p: CheckoutPresentation) => ((p.confirmations = confirmations), p);
  const paused = ctx.watcher?.ready === false;

  switch (c.state) {
    case "EXPIRED":
    case "FAILED":
      return presentStatus(c.state, m);
    case "MANUAL_REVIEW": {
      const p = withConf(presentStatus(reviewStatus(c.reviewReason), m));
      if (c.reviewReason === "late_deposit")
        p.statusDetail =
          "A payment was mined after the payment deadline. It is held for manual review with no automatic payout. Do not pay again; the merchant will follow up.";
      if (c.reviewReason === "no_predeadline_wallet_evidence")
        p.statusDetail =
          "A payment arrived, but it could not be proven to come from the pilot's integrated wallet before the payment deadline. It is held for manual review with no automatic payout. Do not pay again; the merchant will follow up.";
      return p;
    }
    case "COMPLETED": {
      // Completed only with a finalized Base receipt reported by the backend.
      const hash = c.payoutTxHash;
      if (hash && c.payoutExplorerUrl === basescan(hash)) {
        const p = withConf(presentStatus("COMPLETED", m));
        p.receipt = { txHash: hash, explorerUrl: c.payoutExplorerUrl, recorded: false };
        return p;
      }
      return withConf(presentStatus("PAYOUT_PENDING", m, ["completed_without_finalized_receipt"]));
    }
    case "PAYOUT_PENDING":
    case "PAYOUT_SUBMITTED":
    case "PAYOUT_CONFIRMED":
      return withConf(presentStatus("PAYOUT_PENDING", m));
    case "ZEC_CONFIRMED":
      return withConf(presentStatus(c.settlement === "operator-approved" ? "PAYOUT_PENDING" : "ZEC_CONFIRMED", m));
    case "PAYMENT_DETECTED":
    case "VERIFYING":
      if (paused) return withConf(presentStatus("WATCHER_PAUSED", m, ["watcher_not_ready"]));
      return withConf(presentStatus(confirmations ? "CONFIRMING" : "OBSERVING", m));
    case "CREATED":
    case "QUOTED":
      return presentStatus("OBSERVING", m, ["payment_request_not_ready"]);
  }

  // AWAITING_PAYMENT: the only state with a payable request.
  const expiries = [c.paymentDeadline, c.expiresAt, c.quote?.expiresAt].filter((v): v is number => typeof v === "number");
  if (!expiries.length) return presentStatus("UNVERIFIED", m, ["no_expiry"]);
  const expiresAt = Math.min(...expiries);
  const secondsLeft = expiresAt - ctx.now;
  if (secondsLeft <= 0)
    // Real orders keep observing after the payment deadline: the watcher runs
    // behind the tip and may still find a deposit mined in time. Never payable.
    return typeof c.observationDeadline === "number"
      ? presentStatus("WINDOW_CLOSED", m, ["payment_deadline_passed"])
      : presentStatus("EXPIRED", m, ["quote_expired_locally"]);
  if (paused) return presentStatus("WATCHER_PAUSED", m, ["watcher_not_ready"]);
  if (ctx.stale) return presentStatus("OBSERVING", m, ["stale_view"]);
  if (!c.quote || !c.zcashAddress || !c.paymentUri) return presentStatus("UNVERIFIED", m, ["payment_request_missing"]);
  if (!SHIELDED_ADDRESS.test(c.zcashAddress)) return presentStatus("UNVERIFIED", m, ["address"]);
  const uri = parseZip321(c.paymentUri);
  if (!uri || uri.address !== c.zcashAddress || uri.amount !== c.quote.zecAmount)
    return presentStatus("UNVERIFIED", m, ["zip321_mismatch"]);
  const p = presentStatus("OBSERVING", m);
  p.payment = {
    address: c.zcashAddress,
    zecAmount: c.quote.zecAmount,
    zecAmountZat: c.quote.zecAmountZat,
    uri: c.paymentUri,
    expiresAt,
    secondsLeft,
  };
  return p;
}

/** Read the payment API's public watcher health. Null when unknown or unreachable. */
export async function fetchWatcherHealth(
  apiBaseUrl: string,
  init: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<{ ready: boolean } | null> {
  try {
    const res = await (init.fetch ?? fetch)(`${apiBaseUrl.replace(/\/+$/, "")}/api/v1/health`, {
      signal: init.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { watcher?: { ready?: unknown } | null } | null;
    return typeof body?.watcher?.ready === "boolean" ? { ready: body.watcher.ready } : null;
  } catch {
    return null;
  }
}
