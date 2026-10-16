// Standalone loopback snapshot viewer. Never imports the production server/Engine.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import nextModule from "next";
import { Sessions, requireLocal } from "../services/wallet/security.ts";
import { snapshotApi } from "../services/wallet/snapshot-api.ts";
const snapshot = JSON.parse(
  readFileSync(".state/phase6c/snapshot.json", "utf8"),
);
if (snapshot.readOnly !== true || snapshot.liveRefundsEnabled !== false)
  throw Error("invalid_snapshot");
mkdirSync(".state/phase6c", { recursive: true });
const sessions = new Sessions(new DatabaseSync(".state/phase6c/viewer.sqlite"));
const api = snapshotApi(sessions, snapshot);
const next = nextModule as unknown as typeof import("next").default;
const app = next({ dev: false, hostname: "127.0.0.1", port: 3210 });
await app.prepare();
const handler = app.getRequestHandler();
const server = createServer(async (req, res) => {
  try {
    requireLocal(
      req.headers as Record<string, string | undefined>,
      req.method !== "GET",
    );
  } catch {
    res.writeHead(403);
    res.end("Local origin required");
    return;
  }
  const nonce = randomBytes(18).toString("base64");
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`;
  req.headers["x-nonce"] = nonce;
  req.headers["content-security-policy"] = csp;
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  if (req.url?.startsWith("/api/")) await api(req, res);
  else await handler(req, res);
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(3210, "127.0.0.1", () => {
  writeFileSync(
    ".state/phase6c/pairing.json",
    JSON.stringify({ token: sessions.issuePairing() }),
    { mode: 0o600 },
  );
  console.log(
    "Read-only Phase 6C viewer ready on http://127.0.0.1:3210. Pairing token saved locally; no workers or signers.",
  );
});
server.on("error", () => {
  console.error(
    "Snapshot viewer could not bind port; no pairing credentials changed.",
  );
  process.exitCode = 1;
});
