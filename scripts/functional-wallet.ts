// Separate non-spending startup. No legacy Engine, phase7 runtime or key loader.
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import nextModule from "next";
import { Sessions, requireLocal } from "../services/wallet/security.ts";
import { reviewBackend } from "../services/wallet/review-backend.ts";
import { api } from "../services/wallet/api.ts";
import { Store } from "../services/execution/store.ts";
import { SolanaSettlement } from "../services/solana/settlement.ts";
import { SettlementReview } from "../services/wallet/settlement-review.ts";
import { settlementReads } from "../services/wallet/settlement-reads.ts";
import { settlementReviewApi } from "../services/wallet/settlement-review-api.ts";
const path = process.argv[2];
if (process.argv.length !== 3 || !path)
  throw Error("Provide a public review profile JSON path.");
const p = JSON.parse(readFileSync(path, "utf8"));
const profileKeys = [
  "profileId",
  "requestId",
  "relayer",
  "account",
  "paymentAddress",
];
if (
  !p ||
  Object.keys(p).some(
    (k) => !["displayEvmAddress", "recipients", "profile"].includes(k),
  ) ||
  !Array.isArray(p.recipients) ||
  !p.recipients.length ||
  p.recipients.some((a: unknown) => typeof a !== "string") ||
  !p.profile ||
  Object.keys(p.profile).length !== profileKeys.length ||
  profileKeys.some((k) => typeof p.profile[k] !== "string") ||
  Object.keys(p.profile).some((k) => !profileKeys.includes(k))
)
  throw Error("Public review profile required; credentials are not accepted.");
const root = `.state/functional/wallet-${randomUUID()}`;
mkdirSync(root, { recursive: true, mode: 0o700 });
const sessions = new Sessions(new DatabaseSync(`${root}/sessions.sqlite`));
const backend = reviewBackend(sessions, p.displayEvmAddress);
const store = new Store(`${root}/review.sqlite`);
const forbidden = new Proxy(
  {},
  {
    get() {
      throw Error("EXECUTION_DISABLED");
    },
  },
);
const service = new SolanaSettlement(store, forbidden as any);
const review = new SettlementReview(service, settlementReads());
const local = settlementReviewApi(sessions, review, p.profile, p.recipients);
const handler = api(sessions, backend);
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
    res.end("Local origin required.");
    return;
  }
  const nonce = randomBytes(18).toString("base64");
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`;
  req.headers["x-nonce"] = nonce;
  req.headers["content-security-policy"] = csp;
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.url?.startsWith("/api/settlement-review")) await local(req, res);
  else if (req.url?.startsWith("/api/")) await handler(req, res);
  else await web(req, res);
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(3210, "127.0.0.1", () => {
  writeFileSync(
    `${root}/pairing.private.json`,
    JSON.stringify({ token: sessions.issuePairing() }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    `Economic review wallet ready on 127.0.0.1:3210. Local pairing file: ${root}/pairing.private.json. No financial workers or keys loaded.`,
  );
});
server.on("error", () => {
  console.error("Local review server unavailable.");
  process.exitCode = 1;
});
