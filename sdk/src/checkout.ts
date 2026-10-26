// @zecone/sdk/checkout — browser-safe helpers for the customer-facing checkout.
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
  const terminal = (c: CheckoutView) => ["COMPLETED", "EXPIRED", "FAILED"].includes(c.state);
  const deliver = (c: CheckoutView) => {
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
      const c = JSON.parse(e.data) as CheckoutView;
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
