import { readFileSync, writeFileSync } from "node:fs";
import {
  mainnetQuote,
  mainnetQuoteContext,
} from "../services/settlement/mainnet-quote.ts";
import {
  validateProductionProfile,
  type ProductionProfile,
  type SignedPrice,
} from "../services/settlement/production-safety.ts";

type Pricing = {
  feeds: { price: SignedPrice; publicKey: string }[];
  pair: "ETH/ZEC" | "SOL/ZEC";
  networkFee: string;
  l1DataFee: string;
  serviceFee: string;
  ttlSeconds?: number;
  maximumSpreadBps?: number;
};

function args() {
  const [command, ...rest] = process.argv.slice(2),
    values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--") || !rest[i + 1])
      throw Error("INVALID_ARGUMENTS");
    values.set(rest[i].slice(2), rest[++i]);
  }
  return { command, values };
}

function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value) throw Error(`${key.toUpperCase()}_REQUIRED`);
  return value;
}

function profileFor(values: Map<string, string>): {
  network: "base" | "solana";
  profile: ProductionProfile;
} {
  const network = values.get("network");
  if (network !== "base" && network !== "solana")
    throw Error("NETWORK_REQUIRED");
  const profiles = JSON.parse(
      readFileSync(required(values, "profiles"), "utf8"),
    ) as ProductionProfile[],
    profile = profiles.find((p) => p.network === network);
  if (!profile) throw Error("PROFILE_NOT_FOUND");
  return { network, profile: validateProductionProfile(profile) };
}

const { command, values } = args();
if (command === "context") {
  const { network, profile } = profileFor(values),
    pair = values.get("pair"),
    amount = required(values, "amount"),
    networkFee = required(values, "network-fee"),
    l1DataFee = required(values, "l1-data-fee"),
    serviceFee = required(values, "service-fee");
  if (!/^[1-9][0-9]{0,30}$/.test(amount)) throw Error("INVALID_AMOUNT");
  if (
    (network === "base" && pair !== "ETH/ZEC") ||
    (network === "solana" && pair !== "SOL/ZEC")
  )
    throw Error("INVALID_QUOTE_PAIR");
  if (serviceFee !== "0") throw Error("QUOTE_FEE_POLICY_REJECTED");
  const context = mainnetQuoteContext({
    network,
    profile,
    pair: pair as "ETH/ZEC" | "SOL/ZEC",
    destinationUnits: BigInt(amount),
    networkFee: BigInt(networkFee),
    l1DataFee: BigInt(l1DataFee),
    serviceFee: BigInt(serviceFee),
  });
  const out = values.get("out");
  if (out)
    writeFileSync(
      out,
      JSON.stringify({ network, pair, quoteContext: context }, null, 2) + "\n",
    );
  process.stdout.write(
    JSON.stringify({
      status: "QUOTE_CONTEXT_READY",
      network,
      pair,
      quoteContext: context,
      signing: false,
      broadcast: false,
    }) + "\n",
  );
} else if (command === "quote") {
  const { network, profile } = profileFor(values);
  const pricing = JSON.parse(
      readFileSync(required(values, "pricing"), "utf8"),
    ) as Pricing,
    amount = required(values, "amount");
  if (!/^[1-9][0-9]{0,30}$/.test(amount)) throw Error("INVALID_AMOUNT");
  const quote = mainnetQuote({
    network,
    profile,
    pair: pricing.pair,
    feeds: pricing.feeds,
    destinationUnits: BigInt(amount),
    networkFee: BigInt(pricing.networkFee),
    l1DataFee: BigInt(pricing.l1DataFee),
    serviceFee: BigInt(pricing.serviceFee),
    now: Math.floor(Date.now() / 1000),
    ttlSeconds: pricing.ttlSeconds,
    maximumSpreadBps: pricing.maximumSpreadBps,
  });
  writeFileSync(required(values, "out"), JSON.stringify(quote, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({
      status: "QUOTE_READY",
      network,
      sourceZatoshis: quote.sourceZatoshis,
      maximumDestinationDebit: quote.maximumDestinationDebit,
      expires: quote.expires,
      quoteDigest: quote.quoteDigest,
      signing: false,
      broadcast: false,
    }) + "\n",
  );
} else {
  throw Error("UNKNOWN_COMMAND");
}
