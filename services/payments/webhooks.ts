// Signed webhook delivery. Payloads are HMAC-SHA256 signed with the merchant's
// webhook secret; the signature is carried in `X-ZecOne-Signature` as
// `t=<unix>,v1=<hex>` for timestamp + replay protection. Delivery retries with
// exponential backoff; the merchant verifies the signature before processing
// and de-duplicates by the event id.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentEventType, WebhookDelivery } from "./types.ts";
import type { PaymentStore } from "./store.ts";

export const MAX_ATTEMPTS = 8;
const BASE_DELAY_SECONDS = 2;

export function signPayload(secret: string, payload: string, timestamp: number): string {
  const body = `${timestamp}.${payload}`;
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}

export function verifySignature(
  secret: string,
  payload: string,
  signature: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  if (typeof signature !== "string" || typeof payload !== "string" || !secret) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const parts = Object.fromEntries(signature.split(",").map((p) => p.split("=", 2))) as Record<string, string>;
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs(now - t) > tolerance) return false; // replay / stale
  const body = `${t}.${payload}`;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(v1, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface WebhookEnvelope {
  /** Stable event id: merchants de-duplicate on this. */
  id: string;
  /** Kept for backward compatibility with the first SDK release. */
  event: PaymentEventType;
  type: PaymentEventType;
  created: number;
  livemode: boolean;
  attempt: number;
  payment: unknown;
}

export function envelope(
  event: PaymentEventType,
  payment: unknown,
  attempt: number,
  extra: { eventId?: string; created?: number; livemode?: boolean } = {},
): string {
  return JSON.stringify({
    id: extra.eventId ?? `evt_adhoc_${Date.now()}`,
    event,
    type: event,
    created: extra.created ?? Math.floor(Date.now() / 1000),
    livemode: extra.livemode ?? false,
    attempt,
    payment,
  } satisfies WebhookEnvelope);
}

export function backoffDelaySeconds(attempt: number): number {
  // 2, 4, 8, ... capped, deterministic.
  return Math.min(BASE_DELAY_SECONDS * 2 ** Math.max(0, attempt - 1), 300);
}

export function shouldRetry(attempt: number, status: number | null): boolean {
  if (attempt >= MAX_ATTEMPTS) return false;
  if (status === null) return true; // network error / timeout
  return status >= 500 || status === 429 || status === 408;
}

/**
 * Validate a merchant webhook URL. Production requires HTTPS; plain HTTP is only
 * accepted for loopback receivers when explicitly allowed (local development).
 */
export function validateWebhookUrl(raw: unknown, opts: { allowLoopbackHttp: boolean }): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol === "https:") return u.toString();
  if (u.protocol === "http:" && loopback && opts.allowLoopbackHttp) return u.toString();
  return null;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

/**
 * Drains the transactional webhook outbox. Each pending delivery is signed with
 * the merchant's current secret at send time and retried with backoff on
 * network errors, timeouts, 408/429 and 5xx. 4xx responses are final.
 */
export class WebhookDispatcher {
  constructor(
    private readonly store: PaymentStore,
    private readonly render: (paymentId: string) => unknown,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly livemode = false,
  ) {}

  private running = false;

  async drain(now = Math.floor(Date.now() / 1000)): Promise<{ delivered: number; retried: number; failed: number }> {
    if (this.running) return { delivered: 0, retried: 0, failed: 0 };
    this.running = true;
    const stats = { delivered: 0, retried: 0, failed: 0 };
    try {
      for (const d of this.store.pendingWebhooks(now)) {
        const outcome = await this.deliver(d, now);
        stats[outcome]++;
      }
    } finally {
      this.running = false;
    }
    return stats;
  }

  async deliver(d: WebhookDelivery, now: number): Promise<"delivered" | "retried" | "failed"> {
    const wh = this.store.merchantWebhook(d.merchantId) ?? this.store.webhookSecret(d.paymentId);
    if (!wh) {
      this.store.recordWebhookAttempt(d.id, null, "failed", null, now);
      return "failed";
    }
    const attempt = d.attempts + 1;
    const payload = envelope(d.eventType, d.eventType === "webhook.ping" ? null : this.render(d.paymentId), attempt, {
      eventId: `evt_${d.eventId ?? `d${d.id}`}`,
      created: d.createdAt,
      livemode: this.livemode,
    });
    const signature = signPayload(wh.secret, payload, now);
    let status: number | null = null;
    try {
      const res = await this.fetcher(wh.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "ZecOne-Webhooks/1",
          "X-ZecOne-Signature": signature,
          "X-ZecOne-Event": d.eventType,
          "X-ZecOne-Event-Id": `evt_${d.eventId ?? `d${d.id}`}`,
          "X-ZecOne-Payment-Id": d.paymentId,
        },
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      if (res.ok) {
        this.store.recordWebhookAttempt(d.id, status, "delivered", null, now);
        return "delivered";
      }
    } catch {
      status = null;
    }
    if (shouldRetry(attempt, status)) {
      this.store.recordWebhookAttempt(d.id, status, "retry", now + backoffDelaySeconds(attempt), now);
      return "retried";
    }
    this.store.recordWebhookAttempt(d.id, status, "failed", null, now);
    return "failed";
  }
}
