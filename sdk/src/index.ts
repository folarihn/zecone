// @zecone/sdk: server-side client for the ZecOne Merchant Payment API.
//
// SECURITY: `ZecOne` holds a merchant API key and must only run server-side
// (Node.js route handlers, server actions, workers). It refuses to construct in
// a browser. Browser code should use `@zecone/sdk/checkout` or
// `@zecone/sdk/react`, which only need the public, read-only checkout token.
import type {
  CheckoutView,
  CreatePaymentInput,
  MerchantProfile,
  Payment,
  PaymentEvent,
  PaymentState,
  Quote,
  Receipt,
  WebhookEvent,
} from "./types.ts";
import { TERMINAL_PAYMENT_STATES, ZecOneError } from "./types.ts";
import { constructEvent } from "./webhooks.ts";
export * from "./types.ts";
export { constructEvent, verifyWebhook } from "./webhooks.ts";

const USD_RE = /^\d{1,9}(\.\d{1,2})?$/;
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PAYMENT_ID_RE = /^pay_[0-9a-f]{26}$/;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ZecOneOptions {
  /** Merchant secret API key (`zk_..._sk_...`). Keep it in a server environment variable. */
  apiKey: string;
  /** ZecOne API origin. Defaults to the local demo server. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Retries for network errors / 5xx on safe or idempotent requests. */
  maxRetries?: number;
  fetch?: FetchLike;
}

function randomKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `sdk_${c.randomUUID()}`;
  return `sdk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export class ZecOne {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: ZecOneOptions) {
    if (typeof window !== "undefined" && typeof (globalThis as { document?: unknown }).document !== "undefined")
      throw new ZecOneError(
        "ZecOne must not be constructed in a browser: it holds a secret API key. Call it from your server and pass the checkout token to the browser.",
        "browser_forbidden",
        0,
      );
    if (!options?.apiKey) throw new ZecOneError("apiKey is required", "config", 0);
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4321").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  readonly payments = {
    /** Create a payment request. Retries safely with an idempotency key. */
    create: (input: CreatePaymentInput) => this.createPayment(input),
    retrieve: (id: string) =>
      this.defer(() => this.get<{ payment: Payment }>(`/api/v1/payments/${this.id(id)}`)).then((r) => r.payment),
    list: (opts: { limit?: number; offset?: number; state?: PaymentState } = {}) => {
      const q = new URLSearchParams();
      if (opts.limit) q.set("limit", String(opts.limit));
      if (opts.offset) q.set("offset", String(opts.offset));
      if (opts.state) q.set("state", opts.state);
      return this.get<{ payments: Payment[] }>(`/api/v1/payments${q.size ? `?${q}` : ""}`).then((r) => r.payments);
    },
    quote: (id: string) =>
      this.defer(() => this.get<{ quote: Quote }>(`/api/v1/payments/${this.id(id)}/quote`)).then((r) => r.quote),
    events: (id: string) =>
      this.defer(() => this.get<{ events: PaymentEvent[] }>(`/api/v1/payments/${this.id(id)}/events`)).then((r) => r.events),
    /** Receipt for a COMPLETED payment (throws `not_completed` otherwise). */
    receipt: (id: string) =>
      this.defer(() => this.get<{ receipt: Receipt }>(`/api/v1/payments/${this.id(id)}/receipt`)).then((r) => r.receipt),
    cancel: (id: string) =>
      this.defer(() =>
        this.request<{ payment: Payment }>(`/api/v1/payments/${this.id(id)}/cancel`, { method: "POST", body: "{}" }),
      ).then((r) => r.payment),
    /** Poll until the payment reaches a terminal state (server-side helper; prefer webhooks). */
    waitForTerminal: async (id: string, opts: { timeoutMs?: number; intervalMs?: number } = {}) => {
      const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
      for (;;) {
        const p = await this.payments.retrieve(id);
        if (TERMINAL_PAYMENT_STATES.includes(p.state)) return p;
        if (Date.now() > deadline) throw new ZecOneError("timed out waiting for payment", "timeout", 0);
        await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
      }
    },
  };

  readonly webhooks = {
    /** Register (or replace) your endpoint. The signing secret is returned once. */
    register: (url: string) =>
      this.request<{ webhook: { url: string; secret: string } }>("/api/v1/webhooks", {
        method: "POST",
        body: JSON.stringify({ url }),
      }).then((r) => r.webhook),
    retrieve: () =>
      this.get<{ webhook: { url: string | null; configured: boolean }; deliveries: unknown[] }>("/api/v1/webhooks"),
    /** Send a signed `webhook.ping` to your endpoint now. */
    test: () => this.request<{ outcome: string }>("/api/v1/webhooks/test", { method: "POST", body: "{}" }),
    /** Verify a delivery and parse it. Pass the RAW request body. */
    constructEvent: (rawBody: string, signatureHeader: string | null | undefined, secret: string): WebhookEvent =>
      constructEvent(rawBody, signatureHeader, secret),
  };

  readonly merchant = {
    retrieve: () => this.get<{ merchant: MerchantProfile }>("/api/v1/merchant").then((r) => r.merchant),
  };

  /**
   * Wallet-ownership onboarding (no API key needed). Your backend relays these
   * two calls for the merchant's browser wallet; the API key returned by
   * `verify` must be stored server-side.
   */
  static onboarding = {
    challenge: (
      baseUrl: string,
      input: { address: string; chainId: 8453 | 84532; domain: string; uri: string; purpose?: "register" | "signin" },
      fetchImpl: FetchLike = (i, init) => fetch(i, init),
    ) =>
      postJson<{ challenge: { message: string; nonce: string; expiresAt: number } }>(
        fetchImpl,
        `${baseUrl.replace(/\/+$/, "")}/api/v1/merchants/challenge`,
        input,
      ).then((r) => r.challenge),
    verify: (
      baseUrl: string,
      input: { message: string; signature: string; name?: string },
      fetchImpl: FetchLike = (i, init) => fetch(i, init),
    ) =>
      postJson<{
        created: boolean;
        merchant: MerchantProfile;
        apiKey: string | null;
        session: { token: string; expiresAt: number };
      }>(fetchImpl, `${baseUrl.replace(/\/+$/, "")}/api/v1/merchants/verify`, input),
  };

  /** Public checkout view (no key needed), the same data the browser component reads. */
  static checkout(baseUrl: string, id: string, token: string, fetchImpl: FetchLike = (i, init) => fetch(i, init)) {
    return getJson<{ checkout: CheckoutView }>(
      fetchImpl,
      `${baseUrl.replace(/\/+$/, "")}/api/v1/checkout/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`,
    ).then((r) => r.checkout);
  }

  private id(id: string): string {
    if (typeof id !== "string" || !PAYMENT_ID_RE.test(id)) throw new ZecOneError("invalid payment id", "invalid_id", 400);
    return id;
  }

  /** Run `fn` so that synchronous validation errors surface as rejected promises. */
  private defer<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return fn();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  private async createPayment(input: CreatePaymentInput): Promise<Payment> {
    validateCreate(input); // async function: throws become rejections
    const idempotencyKey = input.idempotencyKey ?? randomKey();
    const body: Record<string, unknown> = { amountUsd: input.amountUsd, payoutChain: input.payoutChain ?? "base" };
    if (input.recipient) body.recipient = input.recipient;
    if (input.metadata) body.metadata = input.metadata;
    if (input.description) body.description = input.description;
    const res = await this.request<{ payment: Payment }>("/api/v1/payments", {
      method: "POST",
      body: JSON.stringify(body),
      idempotencyKey,
      retry: true,
    });
    return res.payment;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>(path, { retry: true });
  }

  private async request<T>(
    path: string,
    opts: { method?: string; body?: string; idempotencyKey?: string; retry?: boolean } = {},
  ): Promise<T> {
    const attempts = opts.retry ? this.maxRetries + 1 : 1;
    let lastError: ZecOneError | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
      try {
        return await this.once<T>(path, opts);
      } catch (e) {
        if (!(e instanceof ZecOneError)) throw e;
        lastError = e;
        const retriable = e.code === "network" || e.code === "timeout" || e.status >= 500 || e.status === 429;
        if (!retriable) throw e;
      }
    }
    throw lastError!;
  }

  private async once<T>(path: string, opts: { method?: string; body?: string; idempotencyKey?: string }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "zecone-sdk/0.2",
    };
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body,
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      throw new ZecOneError(aborted ? "request timed out" : `network error: ${(e as Error).message}`, aborted ? "timeout" : "network", 0);
    } finally {
      clearTimeout(timer);
    }
    return parseResponse<T>(res);
  }
}

async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!res.ok) {
    const err = (data.error as { code?: string; message?: string; details?: unknown }) ?? {};
    throw new ZecOneError(err.message ?? `HTTP ${res.status}`, err.code ?? "http_error", res.status, err.details);
  }
  return data as T;
}

async function postJson<T>(fetchImpl: FetchLike, url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new ZecOneError(`network error: ${(e as Error).message}`, "network", 0);
  }
  return parseResponse<T>(res);
}

async function getJson<T>(fetchImpl: FetchLike, url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    throw new ZecOneError(`network error: ${(e as Error).message}`, "network", 0);
  }
  return parseResponse<T>(res);
}

function validateCreate(input: CreatePaymentInput): void {
  if (!input || typeof input !== "object") throw new ZecOneError("input required", "invalid_request", 400);
  if (typeof input.amountUsd !== "string" || !USD_RE.test(input.amountUsd))
    throw new ZecOneError("amountUsd must be a USD decimal string (max 2dp)", "invalid_amount", 400);
  if (input.payoutChain !== undefined && input.payoutChain !== "base")
    throw new ZecOneError("payoutChain must be 'base'", "unsupported_chain", 400);
  if (input.recipient !== undefined && (typeof input.recipient !== "string" || !HEX_ADDRESS_RE.test(input.recipient)))
    throw new ZecOneError("recipient must be a Base address", "invalid_recipient", 400);
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0))
    throw new ZecOneError("idempotencyKey must be a non-empty string", "invalid_idempotency", 400);
}

export type { WebhookEvent };
