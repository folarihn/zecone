// Deprecated: the dashboard now lists payments for the signed-in merchant via
// /api/merchant/payments (wallet-verified session). Kept so old links fail clearly.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { error: { code: "moved", message: "Use /api/merchant/payments with a signed-in merchant session." } },
    { status: 410 },
  );
}
