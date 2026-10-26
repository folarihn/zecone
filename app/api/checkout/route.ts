// Demo storefront: the ZecOne website acts as a merchant ("ZecOne Demo Store")
// to let visitors try a checkout. Its API key stays on the server. Payments are
// demo-mode; completion is driven only by the payment API's server-side demo
// observer replaying recorded mainnet evidence — never by the browser.
import { NextResponse } from "next/server";
import { DEMO_STORE_KEY, limited, relay, sameOrigin, zecone } from "../../lib/zecone-server";

export const dynamic = "force-dynamic";

const PRODUCTS: Record<string, { amountUsd: string; description: string }> = {
  "access-pass": { amountUsd: "1.00", description: "ZecOne Access Pass · 30 days" },
  "pro-month": { amountUsd: "5.00", description: "Pro plan · 1 month" },
  "support-tip": { amountUsd: "2.50", description: "Support the builder" },
};

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: { code: "forbidden", message: "cross-origin request" } }, { status: 403 });
  if (limited(req, "demo-checkout", 12, 60))
    return NextResponse.json({ error: { code: "rate_limited", message: "Too many demo checkouts — try again in a minute." } }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as { product?: string; amountUsd?: string };
  const product = body.product ? PRODUCTS[body.product] : null;
  const amountUsd = product?.amountUsd ?? body.amountUsd;
  if (typeof amountUsd !== "string" || !/^\d{1,4}(\.\d{1,2})?$/.test(amountUsd) || Number(amountUsd) > 50 || Number(amountUsd) <= 0)
    return NextResponse.json({ error: { code: "invalid_amount", message: "Demo checkouts accept $0.01 – $50.00." } }, { status: 400 });
  const r = await zecone("/api/v1/payments", {
    token: DEMO_STORE_KEY,
    body: {
      amountUsd,
      description: product?.description ?? "ZecOne demo payment",
      metadata: { source: "zecone-website", product: body.product ?? "custom" },
    },
  });
  if (r.status >= 300) return relay(r);
  const p = r.data.payment as Record<string, unknown>;
  // Only what the customer's browser needs: a read-only checkout capability.
  return NextResponse.json(
    { payment: { id: p.id, checkoutToken: p.checkoutToken, checkoutUrl: p.checkoutUrl, state: p.state, mode: p.mode } },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
