import { readFileSync, writeFileSync } from "node:fs";
import { mainnetQuote } from "../services/settlement/mainnet-quote.ts";
import {
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

const { command, values } = args();
if (command !== "quote") throw Error("UNKNOWN_COMMAND");
const network = values.get("network");
if (network !== "base" && network !== "solana") throw Error("NETWORK_REQUIRED");
const profiles = JSON.parse(
    readFileSync(required(values, "profiles"), "utf8"),
  ) as ProductionProfile[],
  profile = profiles.find((p) => p.network === network);
if (!profile) throw Error("PROFILE_NOT_FOUND");
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
console.log(
  JSON.stringify({
    status: "QUOTE_READY",
    network,
    sourceZatoshis: quote.sourceZatoshis,
    maximumDestinationDebit: quote.maximumDestinationDebit,
    expires: quote.expires,
    quoteDigest: quote.quoteDigest,
    signing: false,
    broadcast: false,
  }),
);
