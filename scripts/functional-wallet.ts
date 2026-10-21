// Separate non-spending startup. No legacy Engine, phase7 runtime or key loader.
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import nextModule from "next";
import { Sessions, requireLocal } from "../services/wallet/security.ts";
import { reviewBackend } from "../services/wallet/review-backend.ts";
import { api } from "../services/wallet/api.ts";
import { Store } from "../services/execution/store.ts";
import { SolanaSettlement } from "../services/solana/settlement.ts";
import { SolanaSettlementNetwork } from "../services/solana/settlement.ts";
import { SolanaTransferFlow } from "../services/settlement/solana-transfer-flow.ts";
import { SettlementReview } from "../services/wallet/settlement-review.ts";
import { settlementReads } from "../services/wallet/settlement-reads.ts";
import { settlementReviewApi } from "../services/wallet/settlement-review-api.ts";
import { nativeTransferApi } from "../services/wallet/native-transfer-api.ts";
import { NativeTransferFlow } from "../services/settlement/native-transfer-flow.ts";
import { EvmTransferSettlement } from "../services/settlement/evm-transfer.ts";
import { adapterFor } from "../services/evm/adapter.ts";
import { getAddress } from "viem";
import { Dapps } from "../services/wallet/dapps.ts";
import { IntentReviews } from "../services/wallet/transaction-intents.ts";
import { originOf } from "../services/wallet/dapp-policy.ts";
import { WatchOnlyZcash } from "../services/signer/watch-evidence.ts";
import { NativeDestinationDecoder } from "../services/settlement/native-address.ts";
import { providerReserved } from "../services/marketplace/journal.ts";
import {
  SourceBindings,
  historicalSourceAccounts,
} from "../services/settlement/source-bindings.ts";
async function main() {
  process.env.NEXT_TELEMETRY_DISABLED = "1";
  const args = process.argv.slice(2),
    financialCreationEnabled = args.includes("--enable-financial-creation"),
    watchIndex = args.indexOf("--watch-wallet"),
    watchPath = watchIndex >= 0 ? args[watchIndex + 1] : undefined,
    rest = args.filter(
      (a, i) =>
        a !== "--enable-financial-creation" &&
        i !== watchIndex &&
        (watchIndex < 0 || i !== watchIndex + 1),
    ),
    stateIndex = rest.indexOf("--state"),
    statePath = stateIndex >= 0 ? rest[stateIndex + 1] : undefined,
    path = rest[0],
    validShape =
      !!path &&
      (stateIndex < 0
        ? rest.length === 1
        : rest.length === 3 && rest[1] === "--state" && !!statePath);
  if (!validShape)
    throw Error(
      "Usage: functional-wallet <public-profile.json> [--state <dir>] [--enable-financial-creation --watch-wallet <native-watch-dir>]",
    );
  if (financialCreationEnabled && !statePath)
    throw Error("Financial creation requires an explicit --state directory.");
  if (
    (financialCreationEnabled && !watchPath) ||
    (watchIndex >= 0 && !watchPath)
  )
    throw Error(
      "Financial creation requires a native --watch-wallet directory.",
    );
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
      (k) =>
        ![
          "displayEvmAddress",
          "recipients",
          "profile",
          "native",
          "solana",
        ].includes(k),
    ) ||
    !Array.isArray(p.recipients) ||
    !p.recipients.length ||
    p.recipients.some((a: unknown) => typeof a !== "string") ||
    !p.profile ||
    !profileKeys.every((k) => typeof p.profile[k] === "string") ||
    Object.keys(p.profile).some(
      (k) => !profileKeys.includes(k) && k !== "spl",
    ) ||
    (p.profile.spl !== undefined &&
      (!p.profile.spl ||
        p.profile.spl.kind !== "SPL" ||
        typeof p.profile.spl.mint !== "string" ||
        !Number.isInteger(p.profile.spl.decimals)))
  )
    throw Error(
      "Public review profile required; credentials are not accepted.",
    );
  if (
    p.native &&
    (Object.keys(p.native).some(
      (k) => !["chainId", "authorizer", "feeCapWei", "origins"].includes(k),
    ) ||
      !Number.isSafeInteger(p.native.chainId) ||
      getAddress(p.native.authorizer) !== getAddress(p.displayEvmAddress) ||
      !/^[1-9]\d*$/.test(p.native.feeCapWei) ||
      p.profile.spl)
  )
    throw Error("Invalid native transfer configuration.");
  if (
    p.native?.origins !== undefined &&
    (!Array.isArray(p.native.origins) ||
      p.native.origins.some((o: unknown) => typeof o !== "string"))
  )
    throw Error("Invalid origin allowlist.");
  if (p.native) for (const origin of p.native.origins ?? []) originOf(origin);
  if (
    p.solana &&
    (p.native ||
      Object.keys(p.solana).some((k) => k !== "authorizer") ||
      getAddress(p.solana.authorizer) !== getAddress(p.displayEvmAddress))
  )
    throw Error("Invalid Solana authorization profile.");
  if (financialCreationEnabled) {
    if (!p.native && !p.solana)
      throw Error(
        "Signed Solana authorization profile required for financial creation.",
      );
    const legacyRelayer = p.native
      ? getAddress(
          JSON.parse(readFileSync("docs/PUBLIC_WALLETS.json", "utf8")).base
            .relayer,
        )
      : undefined;
    if (
      p.native &&
      getAddress(p.profile.relayer) === legacyRelayer &&
      providerReserved()
    )
      throw Error(
        "Existing provider reservations require operator reconciliation before transfer activation.",
      );
    if (p.profile.spl)
      throw Error(
        "SPL financial checkout requires individual asset validation and remains disabled.",
      );
    if (historicalSourceAccounts().includes(p.profile.account))
      throw Error("Historical source reuse is forbidden.");
    const watch = JSON.parse(
      readFileSync(resolve(watchPath!, "watch-only.json"), "utf8"),
    );
    if (
      watch.network !== "zcash-testnet" ||
      watch.keyId !== p.profile.account ||
      watch.address !== p.profile.paymentAddress
    )
      throw Error("Native watch profile mismatch.");
    await new NativeDestinationDecoder().validate(p.profile.paymentAddress);
  }
  const root = statePath
    ? resolve(statePath)
    : `.state/functional/wallet-${randomUUID()}`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const sessions = new Sessions(new DatabaseSync(`${root}/sessions.sqlite`));
  const backend = reviewBackend(sessions, p.displayEvmAddress);
  const store = new Store(`${root}/review.sqlite`);
  mkdirSync(".state/functional", { recursive: true, mode: 0o700 });
  const bindings = financialCreationEnabled
    ? new SourceBindings(
        new DatabaseSync(".state/functional/source-bindings.sqlite"),
        root,
        historicalSourceAccounts,
      )
    : undefined;
  if (
    store.all().some((o) => {
      const i = JSON.parse(o.intent);
      return (
        i.family !== (p.native ? "evm" : "solana") ||
        i.profileId !== p.profile.profileId ||
        i.requestId !== p.profile.requestId ||
        (p.native &&
          (i.chainId !== p.native.chainId ||
            getAddress(i.relayer) !== getAddress(p.profile.relayer))) ||
        o.account !== p.profile.account ||
        o.address !== p.profile.paymentAddress
      );
    })
  )
    throw Error(
      "Existing wallet state belongs to a different isolated profile.",
    );
  const dapps = p.native
    ? new Dapps(
        getAddress(p.native.authorizer),
        `${root}/dapps.sqlite`,
        undefined,
        { signingDisabled: true, intents: new IntentReviews() },
      )
    : undefined;
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw Error("EXECUTION_DISABLED");
      },
    },
  );
  const service = p.native
    ? undefined
    : new SolanaSettlement(
        store,
        p.solana ? new SolanaSettlementNetwork() : (forbidden as any),
      );
  const review = service
    ? new SettlementReview(service, settlementReads(), undefined, bindings)
    : undefined;
  const solanaFlow =
    p.solana && service && review
      ? new SolanaTransferFlow(review, service, getAddress(p.solana.authorizer))
      : undefined;
  const local = review
    ? settlementReviewApi(sessions, review, p.profile, p.recipients, {
        financialCreationEnabled,
        flow: solanaFlow,
      })
    : undefined;
  const nativeFlow = p.native
    ? new NativeTransferFlow(
        new EvmTransferSettlement(store, adapterFor(p.native.chainId)),
        getAddress(p.native.authorizer),
        bindings,
      )
    : undefined;
  const native = nativeFlow
    ? nativeTransferApi(
        sessions,
        nativeFlow,
        {
          ...p.profile,
          relayer: getAddress(p.profile.relayer),
          feeCapWei: p.native.feeCapWei,
        },
        p.recipients,
        financialCreationEnabled,
        dapps
          ? {
              origins: p.native.origins ?? [],
              context: (session, id) =>
                dapps.nativeTransferContext(session, id),
            }
          : undefined,
      )
    : undefined;
  const handler = api(sessions, backend, dapps);
  const scanner = financialCreationEnabled
    ? new WatchOnlyZcash(resolve(watchPath!))
    : undefined;
  let scanning = false;
  async function observePending() {
    if (!scanner || scanning) return;
    const order = store.all()[0];
    if (!order || !["awaiting_payment", "verified"].includes(order.state))
      return;
    scanning = true;
    try {
      if (nativeFlow) await nativeFlow.observe(order.id, scanner);
      else if (
        service &&
        JSON.parse(order.intent).action === "SOLANA_DEVNET_SOL_DELIVERY"
      ) {
        if (!solanaFlow) throw Error("Signed SOL checkout required.");
        await solanaFlow.observe(order.id, scanner);
      }
    } catch {
      console.warn(
        "Native payment observation unavailable; no execution attempted. Inspect local state.",
      );
    } finally {
      scanning = false;
    }
  }
  const next = nextModule as unknown as typeof import("next").default;
  const app = next({ dev: false, hostname: "127.0.0.1", port: 3210 });
  await app.prepare();
  const web = app.getRequestHandler();
  const server = createServer(async (req, res) => {
    try {
      requireLocal(
        req.headers as Record<string, string | undefined>,
        req.method !== "GET",
        !!native &&
          req.method === "GET" &&
          req.url?.split("?")[0] === "/connect",
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
    if (native && req.url?.startsWith("/api/native-transfer"))
      await native(req, res);
    else if (native && req.url?.startsWith("/api/settlement-review")) {
      res.writeHead(404);
      res.end("Unavailable operation.");
    } else if (local && req.url?.startsWith("/api/settlement-review"))
      await local(req, res);
    else if (req.url?.startsWith("/api/")) await handler(req, res);
    else await web(req, res);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(3210, "127.0.0.1", () => {
    if (scanner) {
      void observePending();
      setInterval(() => void observePending(), 30000).unref();
    }
    writeFileSync(
      `${root}/pairing-${Date.now()}.private.json`,
      JSON.stringify({ token: sessions.issuePairing() }),
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      `Economic wallet ready on 127.0.0.1:3210. Local pairing files are in ${root}. Financial creation: ${
        financialCreationEnabled ? "enabled" : "disabled"
      }. No payment sender, signing keys or broadcast worker loaded.`,
    );
  });
  server.on("error", () => {
    console.error("Local review server unavailable.");
    process.exitCode = 1;
  });
}
void main().catch(() => {
  console.error(
    "Wallet startup failed. Check the public profile, watch identity and supported testnet configuration. No spending worker was started.",
  );
  process.exitCode = 1;
});
