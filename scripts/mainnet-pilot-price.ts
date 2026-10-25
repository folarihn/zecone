// Operator CLI for single-operator pilot pricing. It fetches ETH and ZEC USD
// reference prices from two independent market-data providers, computes a single
// ETH/ZEC rational, binds it to the exact quote context, and signs it with the
// existing execution-authority (pilot) identity. It never prints or exposes the
// seed or passphrase and never submits a transaction.
import { createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mainnetQuoteContext } from "../services/settlement/mainnet-quote.ts";
import {
  buildSingleOperatorPilotPriceStatement,
  signSingleOperatorPilotPrice,
  type PilotMarketObservation,
} from "../services/settlement/mainnet-pilot-pricing.ts";
import {
  openMainnetCredential,
  readMainnetKeystore,
} from "../services/provisioning/mainnet-keystore.ts";
import type { ProductionProfile } from "../services/settlement/production-safety.ts";

function args() {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    if (!flag.startsWith("--") || !process.argv[i + 1])
      throw Error("INVALID_ARGUMENTS");
    values.set(flag.slice(2), process.argv[i + 1]);
  }
  return values;
}
function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value || value.startsWith("--"))
    throw Error(`${key.replaceAll("-", "_").toUpperCase()}_REQUIRED`);
  return value;
}

const PROVIDERS = {
  coingecko: async () => {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,zcash&vs_currencies=usd",
      { signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok) throw Error("COINGECKO_UNAVAILABLE");
    const j = (await r.json()) as {
      ethereum?: { usd?: number };
      zcash?: { usd?: number };
    };
    const ethUsd = j.ethereum?.usd,
      zecUsd = j.zcash?.usd;
    if (typeof ethUsd !== "number" || typeof zecUsd !== "number")
      throw Error("COINGECKO_MALFORMED");
    return { ethUsd: ethUsd.toString(), zecUsd: zecUsd.toString() };
  },
  coinpaprika: async () => {
    const eth = await fetch(
      "https://api.coinpaprika.com/v1/tickers/eth-ethereum?quotes=USD",
      { signal: AbortSignal.timeout(15000) },
    );
    const zec = await fetch(
      "https://api.coinpaprika.com/v1/tickers/zec-zcash?quotes=USD",
      { signal: AbortSignal.timeout(15000) },
    );
    if (!eth.ok || !zec.ok) throw Error("COINPAPRIKA_UNAVAILABLE");
    const e = (await eth.json()) as { quotes?: { USD?: { price?: number } } };
    const z = (await zec.json()) as { quotes?: { USD?: { price?: number } } };
    if (
      typeof e.quotes?.USD?.price !== "number" ||
      typeof z.quotes?.USD?.price !== "number"
    )
      throw Error("COINPAPRIKA_MALFORMED");
    return {
      ethUsd: e.quotes.USD.price.toString(),
      zecUsd: z.quotes.USD.price.toString(),
    };
  },
} as const;

function profileFor(file: string): ProductionProfile {
  const profiles = JSON.parse(
    readFileSync(file, "utf8"),
  ) as ProductionProfile[];
  const base = profiles.find((p) => p.network === "base");
  if (!base) throw Error("BASE_PROFILE_NOT_FOUND");
  return base;
}

function spkiPublicKeyPem(pem: string): string {
  const der = Buffer.from(
    pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""),
    "base64",
  );
  return der.subarray(der.length - 32).toString("base64url");
}

async function main() {
  const values = args();
  if (values.get("confirm") !== "SIGN_PILOT_PRICE")
    throw Error("PILOT_PRICE_CONFIRMATION_REQUIRED");
  const profilesFile = required(values, "profiles"),
    profile = profileFor(profilesFile),
    amount = required(values, "amount"),
    networkFee = required(values, "network-fee"),
    l1DataFee = required(values, "l1-data-fee"),
    serviceFee = required(values, "service-fee"),
    keystore = resolve(required(values, "keystore")),
    passphraseFile = resolve(required(values, "passphrase-file")),
    publicKeyFile = resolve(required(values, "public-key")),
    out = resolve(required(values, "out"));
  if (!/^[1-9][0-9]{0,30}$/.test(amount)) throw Error("INVALID_AMOUNT");
  if (serviceFee !== "0") throw Error("QUOTE_FEE_POLICY_REJECTED");

  const now = Math.floor(Date.now() / 1000);
  const [cg, cc] = await Promise.all([
    PROVIDERS.coingecko(),
    PROVIDERS.coinpaprika(),
  ]);
  const observations: PilotMarketObservation[] = [
    { provider: "coingecko", ethUsd: cg.ethUsd, zecUsd: cg.zecUsd, at: now },
    { provider: "coinpaprika", ethUsd: cc.ethUsd, zecUsd: cc.zecUsd, at: now },
  ];
  const context = mainnetQuoteContext({
    network: "base",
    profile,
    pair: "ETH/ZEC",
    destinationUnits: BigInt(amount),
    networkFee: BigInt(networkFee),
    l1DataFee: BigInt(l1DataFee),
    serviceFee: BigInt(serviceFee),
  });
  const statement = buildSingleOperatorPilotPriceStatement(
    profile.executionAuthority?.identity ?? "single-device-pilot-operator",
    context,
    observations,
    now,
    now + 60,
  );

  const passphrase = readFileSync(passphraseFile);
  let seed: Buffer | undefined;
  try {
    seed = await openMainnetCredential(
      readMainnetKeystore(keystore),
      passphrase,
      "mainnet:execution-authority",
    );
    const publicPem = readFileSync(publicKeyFile, "utf8").trim();
    const privateKey = createPrivateKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        d: seed.toString("base64url"),
        x: spkiPublicKeyPem(publicPem),
      },
      format: "jwk",
    });
    const signature = signSingleOperatorPilotPrice(
      statement,
      privateKey,
    ).signature;
    const pricing = {
      pilotPrice: { statement, signature, publicKey: publicPem },
      pair: "ETH/ZEC",
      maximumSpreadBps: 200,
      networkFee,
      l1DataFee,
      serviceFee,
      ttlSeconds: 60,
    };
    writeFileSync(out, JSON.stringify(pricing, null, 2) + "\n");
    process.stdout.write(
      JSON.stringify({
        status: "PILOT_PRICE_SIGNED",
        policy: statement.policy,
        providerObservations: observations.map((o) => ({
          provider: o.provider,
          ethUsd: o.ethUsd,
          zecUsd: o.zecUsd,
        })),
        numerator: statement.numerator,
        denominator: statement.denominator,
        expires: statement.expires,
        out,
        signing: true,
        broadcast: false,
      }) + "\n",
    );
  } finally {
    seed?.fill(0);
    passphrase.fill(0);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof Error && /^[A-Z0-9_]{1,96}$/.test(error.message)
          ? error.message
          : "PILOT_PRICE_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
});
