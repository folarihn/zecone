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
import { phase7bRuntime } from "../services/solana/phase7b-runtime.ts";
import { settlementApi } from "../services/solana/settlement-api.ts";
import { phase7cRuntime } from "../services/solana/phase7c-runtime.ts";
import { swapApi } from "../services/solana/swap-api.ts";
const phase7c = process.argv.includes("--phase7c");
const phase7b = process.argv.includes("--phase7b"),
  stateDir = process.argv.includes("--phase7c-regression")
    ? ".state/phase7c/regression"
    : phase7c
      ? ".state/phase7c/browser"
      : phase7b
        ? ".state/phase7b/browser"
        : ".state/phase7a";
mkdirSync(stateDir, { recursive: true });
const sessions = new Sessions(new DatabaseSync(`${stateDir}/browser.sqlite`));
sessions.db.exec("DELETE FROM sessions");
const backend = phase7Backend(sessions);
const dapps = new Dapps(
  backend.dashboard().address as `0x${string}`,
  `${stateDir}/dapps.sqlite`,
  undefined,
  { signingDisabled: true },
);
const handler = api(sessions, backend, dapps);
const db = new DatabaseSync(`${stateDir}/solana.sqlite`);
const runtime = phase7c
  ? phase7cRuntime()
  : phase7b
    ? phase7bRuntime()
    : undefined;
const swap =
  phase7c && runtime
    ? swapApi(
        sessions,
        runtime.service,
        runtime.service.swapPolicy!,
        runtime.p,
        runtime.manifest,
      )
    : undefined;
const delivery = runtime
  ? settlementApi(sessions, runtime.service, runtime.p, runtime.manifest)
  : undefined;
const solana = solanaApi(
  sessions,
  new SolanaJournal(db),
  new SolanaPermissions(
    db,
    phase7c ? [] : Accounts.list().map((a) => a.address),
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
  if (
    swap &&
    (req.url?.startsWith("/api/solana-swap/") ||
      req.url?.startsWith("/api/solana-settlement/") ||
      req.url?.startsWith("/api/solana/"))
  )
    await swap(req, res);
  else if (swap && req.url?.startsWith("/api/checkouts")) {
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ checkouts: [], liveRefundsEnabled: false }));
  } else if (
    delivery &&
    (req.url?.startsWith("/api/solana-settlement/") ||
      req.url?.startsWith("/api/checkouts"))
  )
    await delivery(req, res);
  else if (req.url?.startsWith("/api/solana/")) await solana(req, res);
  else if (req.url?.startsWith("/api/")) await handler(req, res);
  else await web(req, res);
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(3210, "127.0.0.1", () => {
  writeFileSync(
    `${stateDir}/pairing.json`,
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
