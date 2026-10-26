// Read-only checkout status by payment id + checkout token (the same capability
// the hosted and embedded checkout use). There is deliberately no POST here:
// payment completion can never be triggered from the browser.
import { NextResponse } from "next/server";
import { relay, zecone } from "../../../lib/zecone-server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^pay_[0-9a-f]{26}$/.test(id) || !/^[0-9a-f]{40}$/.test(token))
    return NextResponse.json({ error: { code: "not_found", message: "checkout not found" } }, { status: 404 });
  return relay(await zecone(`/api/v1/checkout/${id}?token=${token}`));
}
