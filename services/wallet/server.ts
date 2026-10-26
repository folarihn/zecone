import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import nextModule from "next";
import { Engine } from "./engine.ts";
import { Sessions, requireLocal } from "./security.ts";
import { api } from "./api.ts";
import { Dapps } from "./dapps.ts";
import { Purchases } from "../marketplace/service.ts";
import { Swaps } from "../swaps/service.ts";
import { SeaportPurchases } from "../seaport/service.ts";
import { OpenSeaPreviews } from "../opensea/service.ts";
import { readJson } from "../execution/io.ts";
import { getAddress } from "viem";
import { readOnlyIntentReviews } from "./intent-rpc.ts";
import type { EvmRoute } from "./transaction-intents.ts";
const dev = process.argv.includes("--dev");
process.env.NEXT_TELEMETRY_DISABLED = "1";
// Next's CommonJS runtime is callable; its NodeNext declaration wraps the default.
const next = nextModule as unknown as typeof import("next").default;
// The local wallet gateway serves the wallet at "/"; the public site uses /wallet.
process.env.ZECONE_SURFACE ??= "wallet";
const app = next({ dev, webpack: true, hostname: "127.0.0.1", port: 3210 });
await app.prepare();
const engine = new Engine(),
  sessions = new Sessions(engine.app.db),
  purchases = new Purchases(),
  swaps = new Swaps(),
  seaport = new SeaportPurchases(),
  dapps = new Dapps(engine.address, ".state/dapps.sqlite", purchases, process.argv.includes("--intent-previews") ? {
    signingDisabled: true,
    intents: readOnlyIntentReviews(engine.address, process.env.ZECONE_INTENT_ROUTES ? readJson<EvmRoute[]>(process.env.ZECONE_INTENT_ROUTES) : []),
  } : {}),
  opensea = new OpenSeaPreviews(engine.address, getAddress(readJson<{base:{relayer:string}}>("docs/PUBLIC_WALLETS.json").base.relayer)),
  handler = api(sessions, engine, dapps, purchases, swaps, seaport, opensea),
  nextHandler = app.getRequestHandler();
const server = createServer(async (req, res) => {
  try {
    const publicConnect =
      req.method === "GET" &&
      req.url?.split("?")[0] === "/connect" &&
      req.headers.host === "127.0.0.1:3210" &&
      req.headers["sec-fetch-mode"] === "navigate" &&
      req.headers["sec-fetch-dest"] === "document";
    if (!publicConnect)
      requireLocal(req.headers as Record<string, string | undefined>, false);
  } catch {
    res.writeHead(403);
    res.end("Local origin required");
    return;
  }
  const nonce = randomBytes(18).toString("base64");
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'${dev ? " ws://127.0.0.1:3210" : ""}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`;
  req.headers["x-nonce"] = nonce;
  req.headers["content-security-policy"] = csp;
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Referrer-Policy", "no-referrer");
  // The explicitly opened approval popup needs its opener for origin-bound messaging.
  // Keep this exception limited to the public connector document; private wallet pages
  // retain the browser's default opener isolation policy.
  if (req.url?.split("?")[0] === "/connect")
    res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
  else res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  if (req.url?.startsWith("/api/")) await handler(req, res);
  else await nextHandler(req, res);
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(3210, "127.0.0.1", () => {
  engine.recoverInterrupted();
  mkdirSync(".secrets", { recursive: true });
  writeFileSync(
    ".secrets/browser-pairing.json",
    JSON.stringify({
      token: sessions.issuePairing(),
      expires: Date.now() + 600000,
    }),
    { mode: 0o600 },
  );
  console.log(
    "ZecOne is ready at http://127.0.0.1:3210. Open Launch-ZecOne.cmd to unlock.",
  );
  engine.refresh();
  setInterval(() => engine.refresh(), 15000).unref();
  setInterval(() => void dapps.reconcile(), 10000).unref();
  void purchases.tick();
  setInterval(() => void purchases.tick(), 20000).unref();
  void swaps.tick();
  setInterval(() => void swaps.tick(), 25000).unref();
  void seaport.tick();
  setInterval(() => void seaport.tick(), 30000).unref();
});
server.on("error", () => {
  console.error(
    "ZecOne could not bind its local port. Close another instance before starting.",
  );
  process.exitCode = 1;
});
