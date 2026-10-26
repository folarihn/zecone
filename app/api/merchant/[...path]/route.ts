// Merchant dashboard BFF. The browser holds only an httpOnly session cookie that
// was issued after an EIP-4361 wallet signature; this handler forwards an
// allowlisted set of calls to the ZecOne API with that session. Merchant API
// keys are displayed once at creation/rotation and never stored here.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, limited, relay, sameOrigin, sessionToken, siweOrigin, unauthorized, zecone } from "../../../lib/zecone-server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, { params }: Ctx) {
  const path = (await params).path.join("/");
  const token = await sessionToken();
  if (!token) return unauthorized();
  const url = new URL(req.url);
  switch (path) {
    case "me":
      return relay(await zecone("/api/v1/merchant", { token }));
    case "payments": {
      const q = new URLSearchParams();
      for (const k of ["limit", "offset", "state"]) if (url.searchParams.get(k)) q.set(k, url.searchParams.get(k)!);
      return relay(await zecone(`/api/v1/payments${q.size ? `?${q}` : ""}`, { token }));
    }
    case "webhook":
      return relay(await zecone("/api/v1/webhooks", { token }));
  }
  const m = /^payments\/(pay_[0-9a-f]{26})(?:\/(receipt|events))?$/.exec(path);
  if (m) return relay(await zecone(`/api/v1/payments/${m[1]}${m[2] ? `/${m[2]}` : ""}`, { token }));
  return NextResponse.json({ error: { code: "not_found", message: "unknown endpoint" } }, { status: 404 });
}

export async function POST(req: Request, { params }: Ctx) {
  const path = (await params).path.join("/");
  if (!sameOrigin(req)) return NextResponse.json({ error: { code: "forbidden", message: "cross-origin request" } }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const origin = siweOrigin(req);

  // ---- unauthenticated: wallet-ownership onboarding ----
  if (path === "challenge") {
    if (limited(req, "siwe", 20, 60)) return NextResponse.json({ error: { code: "rate_limited", message: "slow down" } }, { status: 429 });
    return relay(
      await zecone("/api/v1/merchants/challenge", {
        body: { address: body.address, chainId: body.chainId, purpose: body.purpose === "signin" ? "signin" : "register", ...origin },
      }),
    );
  }
  if (path === "verify") {
    if (limited(req, "siwe", 20, 60)) return NextResponse.json({ error: { code: "rate_limited", message: "slow down" } }, { status: 429 });
    const r = await zecone("/api/v1/merchants/verify", {
      body: { message: body.message, signature: body.signature, name: body.name },
    });
    if (r.status >= 300) return relay(r);
    const session = r.data.session as { token: string; expiresAt: number };
    const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
    (await cookies()).set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "strict",
      secure,
      path: "/api/merchant",
      expires: new Date(session.expiresAt * 1000),
    });
    // The session token itself is not returned to the page.
    return NextResponse.json(
      { created: r.data.created, merchant: r.data.merchant, apiKey: r.data.apiKey, apiKeyNote: r.data.apiKeyNote },
      { status: r.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  const token = await sessionToken();
  if (!token) return unauthorized();
  switch (path) {
    case "logout": {
      await zecone("/api/v1/merchant/logout", { token, body: {} });
      (await cookies()).delete({ name: SESSION_COOKIE, path: "/api/merchant" });
      return NextResponse.json({ ok: true });
    }
    case "payments":
      return relay(
        await zecone("/api/v1/payments", {
          token,
          body: { amountUsd: body.amountUsd, description: body.description, metadata: body.metadata },
          headers: typeof body.idempotencyKey === "string" ? { "Idempotency-Key": body.idempotencyKey } : {},
        }),
      );
    case "webhook":
      return relay(await zecone("/api/v1/webhooks", { token, body: { url: body.url } }));
    case "webhook/test":
      return relay(await zecone("/api/v1/webhooks/test", { token, body: {} }));
    case "keys":
      return relay(await zecone("/api/v1/merchant/keys", { token, body: { revokeOthers: body.revokeOthers === true } }));
    case "payout/challenge":
      return relay(await zecone("/api/v1/merchant/payout-address/challenge", { token, body: { address: body.address, chainId: body.chainId, ...origin } }));
    case "payout":
      return relay(await zecone("/api/v1/merchant/payout-address", { token, body: { message: body.message, signature: body.signature } }));
  }
  const m = /^payments\/(pay_[0-9a-f]{26})\/cancel$/.exec(path);
  if (m) return relay(await zecone(`/api/v1/payments/${m[1]}/cancel`, { token, body: {} }));
  return NextResponse.json({ error: { code: "not_found", message: "unknown endpoint" } }, { status: 404 });
}
