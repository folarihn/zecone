// Server-only helpers for talking to the ZecOne payment API from route handlers.
// Credentials (the demo storefront key and merchant session tokens) never reach
// the browser: sessions live in an httpOnly cookie and are forwarded here.
import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const ZECONE_API = (process.env.ZECONE_BASE_URL ?? "http://127.0.0.1:4321").replace(/\/+$/, "");
export const DEMO_STORE_KEY =
  process.env.ZECONE_API_KEY ?? `zk_${"0".repeat(24)}_${process.env.ZECONE_DEMO_SECRET ?? "demo-merchant-secret-change-me"}`;
export const SESSION_COOKIE = "zecone_session";

export async function zecone(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = { Accept: "application/json", ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  try {
    const res = await fetch(`${ZECONE_API}${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    return { status: res.status, data: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  } catch {
    return {
      status: 502,
      data: { error: { code: "api_unavailable", message: "ZecOne payment API is unreachable. Start it with `npm run payments:start`." } },
    };
  }
}

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

export function relay(r: { status: number; data: Record<string, unknown> }) {
  return NextResponse.json(r.data, { status: r.status, headers: { "Cache-Control": "no-store" } });
}

export function unauthorized() {
  return NextResponse.json({ error: { code: "unauthorized", message: "Connect your wallet and sign in first." } }, { status: 401 });
}

/** The EIP-4361 domain/uri must describe the page the merchant is signing on. */
export function siweOrigin(req: Request): { domain: string; uri: string } {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return { domain: host, uri: `${proto}://${host}/dashboard` };
}

/** Same-origin check for state-changing browser requests (CSRF defence in depth). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const buckets = new Map<string, { n: number; reset: number }>();
export function limited(req: Request, bucket: string, max: number, windowSeconds: number): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowSeconds * 1000 });
    return false;
  }
  b.n++;
  return b.n > max;
}
