// Isolated validation backend; never creates Engine or any settlement worker.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import nextModule from "next";
import { Sessions, requireLocal } from "../services/wallet/security.ts";
import { api } from "../services/wallet/api.ts";
import { phase7Backend } from "../services/wallet/phase7a-backend.ts";
import { Dapps } from "../services/wallet/dapps.ts";
import { Accounts } from "../services/solana/accounts.ts";
import { solanaApi } from "../services/solana/api.ts";
import { SolanaJournal } from "../services/solana/journal.ts";
import { SolanaPermissions } from "../services/solana/provider.ts";
mkdirSync(".state/phase7a", { recursive: true });
const sessions = new Sessions(
  new DatabaseSync(".state/phase7a/browser.sqlite"),
);
sessions.db.exec("DELETE FROM sessions");
const backend = phase7Backend(sessions);
const dapps = new Dapps(
  backend.dashboard().address as `0x${string}`,
  ".state/phase7a/dapps.sqlite",
  undefined,
  { signingDisabled: true },
);
const handler = api(sessions, backend, dapps);
const db = new DatabaseSync(".state/phase7a/solana.sqlite");
const solana = solanaApi(
  sessions,
  new SolanaJournal(db),
  new SolanaPermissions(
    db,
    Accounts.list().map((a) => a.address),
  ),
);
const next = nextModule as unknown as typeof import("next").default;
const app = next({ dev: false, hostname: "127.0.0.1", port: 3210 });
await app.prepare();
const web = app.getRequestHandler();
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
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  // Approval popups need their browser-provided opener; no cross-origin isolation header here.
  if (req.url?.startsWith("/api/solana/")) await solana(req, res);
  else if (req.url?.startsWith("/api/")) await handler(req, res);
  else await web(req, res);
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(3210, "127.0.0.1", () => {
  writeFileSync(
    ".state/phase7a/pairing.json",
    JSON.stringify({ token: sessions.issuePairing() }),
    { mode: 0o600 },
  );
  console.log(
    `Isolated Phase 7A wallet: http://127.0.0.1:3210; disposable EVM ${backend.dashboard().address}. Pairing saved locally. No broadcasts or dApp signatures.`,
  );
});
server.on("error", () => {
  console.error("Phase 7A port unavailable; pairing unchanged.");
  process.exitCode = 1;
});
