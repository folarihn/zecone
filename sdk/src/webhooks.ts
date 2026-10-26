// Webhook verification helpers for merchants (server-side).
//
// Always verify against the RAW request body — re-serialising parsed JSON can
// change bytes and break the signature. Reject stale timestamps (replay) and
// de-duplicate on `event.id`; deliveries are at-least-once.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEvent } from "./types.ts";
import { ZecOneError } from "./types.ts";

export function verifyWebhook(
  secret: string,
  payload: string,
  signature: string | null | undefined,
  opts: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  if (!secret || typeof payload !== "string" || typeof signature !== "string") return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const parts = Object.fromEntries(signature.split(",").map((p) => p.trim().split("=", 2))) as Record<string, string>;
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs(now - t) > tolerance) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const a = Buffer.from(v1, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verify and parse a webhook delivery; throws `ZecOneError("invalid_signature")` on failure. */
export function constructEvent(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): WebhookEvent {
  if (!verifyWebhook(secret, rawBody, signatureHeader, opts))
    throw new ZecOneError("webhook signature verification failed", "invalid_signature", 401);
  const event = JSON.parse(rawBody) as WebhookEvent;
  if (!event || typeof event.id !== "string" || typeof event.type !== "string")
    throw new ZecOneError("malformed webhook payload", "invalid_payload", 400);
  return event;
}

/** Produce a signature header (useful for testing your endpoint). */
export function signWebhook(secret: string, payload: string, timestamp: number): string {
  const hmac = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}
