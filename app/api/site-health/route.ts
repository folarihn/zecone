// Identity + connectivity check for the ZecOne web app (used by
// scripts/verify-windows.ps1 to tell this app apart from anything else on the port).
import { ZECONE_API } from "../../lib/zecone-server";

export const dynamic = "force-dynamic";

export async function GET() {
  let payments: unknown = null;
  try {
    const r = await fetch(`${ZECONE_API}/api/v1/health`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    payments = r.ok ? await r.json() : { status: r.status };
  } catch {
    payments = null;
  }
  return Response.json(
    { service: "zecone-web", paymentsApi: ZECONE_API, payments },
    { headers: { "Cache-Control": "no-store" } },
  );
}
