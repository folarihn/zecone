// Same-origin proxy for the payment API's PUBLIC, read-only endpoints.
//
// Implemented as a route handler (not next.config rewrites) so the target is read
// from ZECONE_BASE_URL at request time: a production build is no longer pinned to
// the API address that happened to be set when `next build` ran.
// Only token-scoped checkout reads, checkout SSE, quote preview and health pass
// through; nothing authenticated is reachable here.
import { ZECONE_API } from "../../../../lib/zecone-server";

export const dynamic = "force-dynamic";

const ALLOWED = [
  /^checkout\/pay_[0-9a-f]{26}$/,
  /^checkout\/pay_[0-9a-f]{26}\/events$/,
  /^quote\/preview$/,
  /^health$/,
];

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join("/");
  if (!ALLOWED.some((r) => r.test(path)))
    return Response.json({ error: { code: "not_found", message: "unknown endpoint" } }, { status: 404 });
  const search = new URL(req.url).search;
  const sse = path.endsWith("/events");
  let upstream: Response;
  try {
    upstream = await fetch(`${ZECONE_API}/api/v1/${path}${search}`, {
      headers: { Accept: sse ? "text/event-stream" : "application/json" },
      cache: "no-store",
      signal: sse ? req.signal : AbortSignal.timeout(10_000),
    });
  } catch {
    return Response.json(
      { error: { code: "api_unavailable", message: `ZecOne payment API is unreachable at ${ZECONE_API}. Start it with \`npm run payments:start\`.` } },
      { status: 502 },
    );
  }
  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    // no-transform keeps compression from buffering the event stream.
    "Cache-Control": "no-store, no-transform",
  });
  if (sse) headers.set("X-Accel-Buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers });
}
