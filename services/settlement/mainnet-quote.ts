import { createHash, createPublicKey } from "node:crypto";
import {
  productionPrice,
  validateProductionProfile,
  type ProductionProfile,
  type SignedPrice,
} from "./production-safety.ts";

export type MainnetQuoteInput = {
  network: "base" | "solana";
  profile: ProductionProfile;
  pair: "ETH/ZEC" | "SOL/ZEC";
  feeds: readonly { price: SignedPrice; publicKey: string }[];
  destinationUnits: bigint;
  networkFee: bigint;
  l1DataFee: bigint;
  serviceFee: bigint;
  now: number;
  ttlSeconds?: number;
  maximumSpreadBps?: number;
};

export type MainnetQuoteContextInput = Pick<
  MainnetQuoteInput,
  | "network"
  | "profile"
  | "pair"
  | "destinationUnits"
  | "networkFee"
  | "l1DataFee"
  | "serviceFee"
>;

export type MainnetQuote = {
  version: 1;
  network: "base" | "solana";
  pair: "ETH/ZEC" | "SOL/ZEC";
  destinationUnits: string;
  destinationAmount: string;
  sourceZatoshis: string;
  networkFee: string;
  l1DataFee: string;
  serviceFee: string;
  totalFee: string;
  maximumDestinationDebit: string;
  maximumSourceSpend: string;
  createdAt: number;
  expires: number;
  priceExpires: number;
  priceConfidence: "CORROBORATED_SIGNED_PRICES";
  feedsDigest: string;
  profileDigest: string;
  quoteDigest: string;
};

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function mainnetQuoteContext(input: MainnetQuoteContextInput) {
  return digest({
    network: input.network,
    pair: input.pair,
    destinationUnits: input.destinationUnits.toString(),
    networkFee: input.networkFee.toString(),
    l1DataFee: input.l1DataFee.toString(),
    serviceFee: input.serviceFee.toString(),
    profileDigest: digest(input.profile),
  });
}
function assertAuthorizedFeeds(input: MainnetQuoteInput) {
  const pins = input.profile.priceAuthorities;
  if (!pins || pins.length !== 2 || input.feeds.length !== 2)
    throw Error("AUTHORIZED_PRODUCTION_PRICE_FEEDS_REQUIRED");
  const key = (s: string) =>
    createPublicKey(s).export({ format: "der", type: "spki" }).toString("hex");
  if (
    new Set(pins.map((p) => key(p.publicKey))).size !== 2 ||
    new Set(pins.map((p) => p.operator.trim().toLowerCase())).size !== 2
  )
    throw Error("INDEPENDENT_AUTHORIZED_PRICE_KEYS_REQUIRED");
  const context = mainnetQuoteContext(input);
  for (const f of input.feeds) {
    const pin = pins.find((p) => p.operator === f.price.statement.operator);
    if (
      !pin ||
      key(pin.publicKey) !== key(f.publicKey) ||
      f.price.statement.network !== `${input.network}-mainnet` ||
      f.price.statement.quoteContext !== context
    )
      throw Error("UNAUTHORIZED_OR_UNBOUND_PRODUCTION_PRICE");
  }
}

export function mainnetQuote(input: MainnetQuoteInput): MainnetQuote {
  const p = validateProductionProfile(input.profile),
    ttl = input.ttlSeconds ?? 60,
    spread = input.maximumSpreadBps ?? 100;
  if (input.network !== "base" && input.network !== "solana")
    throw Error("INVALID_QUOTE_NETWORK");
  if (
    p.network !== input.network ||
    !p.enabled ||
    (input.network === "base" && input.pair !== "ETH/ZEC") ||
    (input.network === "solana" && input.pair !== "SOL/ZEC") ||
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    ttl > 120 ||
    !Number.isSafeInteger(input.now) ||
    input.destinationUnits <= 0n ||
    input.networkFee < 0n ||
    input.l1DataFee < 0n ||
    input.serviceFee < 0n ||
    (input.network === "solana" && input.l1DataFee !== 0n)
  )
    throw Error("INVALID_QUOTE_INPUT");
  if (
    input.networkFee + input.l1DataFee + input.serviceFee > BigInt(p.feeCap) ||
    input.destinationUnits +
      input.networkFee +
      input.l1DataFee +
      input.serviceFee >
      BigInt(p.perTransaction)
  )
    throw Error("QUOTE_EXCEEDS_PROFILE_LIMIT");
  assertAuthorizedFeeds(input);
  const price = productionPrice(
      input.feeds,
      input.pair,
      input.destinationUnits,
      input.network === "base" ? 18 : 9,
      input.now,
      spread,
    ),
    totalFee = input.networkFee + input.l1DataFee + input.serviceFee,
    debit = input.destinationUnits + totalFee,
    maximumDestinationDebit = BigInt(p.perTransaction),
    feeCap = BigInt(p.feeCap);
  if (totalFee > feeCap || debit > maximumDestinationDebit)
    throw Error("QUOTE_EXCEEDS_PROFILE_LIMIT");
  if (totalFee > BigInt(p.feeCap) || input.serviceFee > 0n)
    throw Error("QUOTE_FEE_POLICY_REJECTED");
  const body = {
    version: 1 as const,
    network: input.network,
    pair: input.pair,
    destinationUnits: input.destinationUnits.toString(),
    destinationAmount: input.destinationUnits.toString(),
    sourceZatoshis: price.zatoshis,
    networkFee: input.networkFee.toString(),
    l1DataFee: input.l1DataFee.toString(),
    serviceFee: input.serviceFee.toString(),
    totalFee: totalFee.toString(),
    maximumDestinationDebit: debit.toString(),
    maximumSourceSpend: price.zatoshis,
    createdAt: input.now,
    expires: Math.min(price.expires, input.now + ttl),
    priceExpires: price.expires,
    priceConfidence: "CORROBORATED_SIGNED_PRICES" as const,
    feedsDigest: digest(input.feeds),
    profileDigest: digest(p),
  };
  return { ...body, quoteDigest: digest(body) };
}

export function assertMainnetQuote(
  quote: MainnetQuote,
  input: MainnetQuoteInput,
  now = Math.floor(Date.now() / 1000),
) {
  if (
    quote.version !== 1 ||
    !Number.isSafeInteger(quote.createdAt) ||
    !Number.isSafeInteger(quote.expires) ||
    quote.createdAt > now + 5 ||
    quote.expires <= now ||
    quote.expires - quote.createdAt > 120
  )
    throw Error("MAINNET_QUOTE_EXPIRED");
  const expected = mainnetQuote({ ...input, now: quote.createdAt });
  if (
    expected.quoteDigest !== quote.quoteDigest ||
    digest(expected) !== digest(quote)
  )
    throw Error("MAINNET_QUOTE_MISMATCH");
  return quote;
}
