// Vercel same-origin proxy for the static Access Pass frontend. The backend and
// all merchant credentials remain on the VPS; only /api/* is forwarded.
export default async function handler(req, res) {
  const backend = String(process.env.ACCESS_PASS_BACKEND_URL ?? "").replace(/\/+$/, "");
  const publicUrl = String(process.env.ACCESS_PASS_PUBLIC_URL ?? "").replace(/\/+$/, "");
  if (!backend.startsWith("https://") || !publicUrl.startsWith("https://")) {
    return res.status(503).json({ error: { code: "not_configured", message: "Access Pass proxy is not configured" } });
  }

  const incoming = new URL(req.url, publicUrl);
  if (!incoming.pathname.startsWith("/api/")) return res.status(404).end();
  const target = new URL(`${incoming.pathname}${incoming.search}`, `${backend}/`);
  const headers = { Origin: new URL(publicUrl).origin };
  if (req.headers.cookie) headers.Cookie = req.headers.cookie;
  if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
  const hasBody = !["GET", "HEAD"].includes(req.method ?? "GET");
  const body = hasBody
    ? typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body ?? {})
    : undefined;

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body,
    redirect: "manual",
  });
  res.status(upstream.status);
  for (const name of ["content-type", "cache-control", "set-cookie"]) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(Buffer.from(await upstream.arrayBuffer()));
}
