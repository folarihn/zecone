// Single-operator pilot pricing. This is deliberately NOT a second signing
// authority: one operator fetches ETH and ZEC reference prices from two
// independently operated market-data providers, computes a single ETH/ZEC
// rational, and signs the resulting statement with the pilot's own Ed25519
// identity (the execution authority). Production keeps the two-independent-
// operator Ed25519 verification path mandatory and untouched.
import { createHash, createPublicKey, sign, verify } from "node:crypto";
import {
  singleDevicePilotActive,
  pilotQuoteMaximumSeconds,
  type ProductionProfile,
} from "./production-safety.ts";

export const PILOT_PRICING_POLICY = "SINGLE_OPERATOR_PILOT_PRICING" as const;
const USD_SCALE = 8;
const DEFAULT_MAX_SPREAD_BPS = 200;
const MAX_OBSERVATION_AGE_SECONDS = 90;
const MAX_EXPIRY_WINDOW_SECONDS = 120;
const integer = (v: unknown, label: string) => {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,40}$/.test(v))
    throw Error(`INVALID_${label}`);
  return BigInt(v);
};

export type PilotMarketObservation = {
  provider: string;
  ethUsd: string;
  zecUsd: string;
  at: number;
};

export type SingleOperatorPilotPriceStatement = {
  version: 1;
  policy: typeof PILOT_PRICING_POLICY;
  operator: string;
  pair: "ETH/ZEC";
  numerator: string;
  denominator: string;
  at: number;
  expires: number;
  network: "base-mainnet";
  quoteContext: string;
  observations: PilotMarketObservation[];
};

export type SingleOperatorPilotPrice = {
  statement: SingleOperatorPilotPriceStatement;
  signature: string;
  publicKey: string;
};

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Parse a USD decimal string like "2370.71" into a scaled BigInt (USD * 10^12).
// Truncates fractional digits beyond 8 decimals.
export function usdToScaled(value: string, label = "USD"): bigint {
  if (typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/.test(value.trim()))
    throw Error(`INVALID_${label}`);
  const [whole, frac = ""] = value.trim().split(".");
  if (whole.replace(/^0+/, "").length > 12) throw Error(`${label}_OVERFLOW`);
  const wholePart = BigInt(whole.replace(/^0+(?=\d)/, "") || "0");
  const fracPart = BigInt(
    frac.slice(0, USD_SCALE).padEnd(USD_SCALE, "0") || "0",
  );
  const scaled = wholePart * 10n ** BigInt(USD_SCALE) + fracPart;
  if (scaled <= 0n) throw Error(`INVALID_${label}`);
  return scaled;
}

function bpsSpread(a: bigint, b: bigint): number {
  const lo = a < b ? a : b;
  if (lo === 0n) return Number.POSITIVE_INFINITY;
  const diff = a > b ? a - b : b - a;
  return Number((diff * 10000n) / lo);
}

export function validatePilotObservations(
  observations: PilotMarketObservation[],
  now: number,
  maximumSpreadBps = DEFAULT_MAX_SPREAD_BPS,
): { numerator: string; denominator: string } {
  if (!Array.isArray(observations) || observations.length !== 2)
    throw Error("PILOT_PRICE_TWO_PROVIDERS_REQUIRED");
  const providers = new Set<string>();
  const eth: bigint[] = [];
  const zec: bigint[] = [];
  for (const o of observations) {
    if (!o.provider.trim()) throw Error("PILOT_PRICE_PROVIDER_REQUIRED");
    if (providers.has(o.provider.trim().toLowerCase()))
      throw Error("PILOT_PRICE_PROVIDERS_MUST_DIFFER");
    providers.add(o.provider.trim().toLowerCase());
    if (
      !Number.isSafeInteger(o.at) ||
      o.at > now + 5 ||
      now - o.at > MAX_OBSERVATION_AGE_SECONDS
    )
      throw Error("PILOT_PRICE_STALE");
    eth.push(usdToScaled(o.ethUsd, "ETH_USD"));
    zec.push(usdToScaled(o.zecUsd, "ZEC_USD"));
  }
  const ethSpread = bpsSpread(eth[0], eth[1]);
  const zecSpread = bpsSpread(zec[0], zec[1]);
  if (ethSpread > maximumSpreadBps || zecSpread > maximumSpreadBps)
    throw Error("PILOT_PRICE_PROVIDER_DISAGREEMENT");
  // ETH/ZEC = ETH_USD / ZEC_USD (ZEC per 1 ETH). Use the higher rate so the
  // source spend is never understated.
  const rateA = { n: eth[0], d: zec[0] };
  const rateB = { n: eth[1], d: zec[1] };
  const higher = rateA.n * rateB.d >= rateB.n * rateA.d ? rateA : rateB;
  return {
    numerator: higher.n.toString(),
    denominator: higher.d.toString(),
  };
}

export function pilotPriceSourceZatoshis(
  numerator: string,
  denominator: string,
  destinationUnits: bigint,
): bigint {
  const n = integer(numerator, "PRICE_NUMERATOR");
  const d = integer(denominator, "PRICE_DENOMINATOR");
  if (destinationUnits <= 0n) throw Error("INVALID_DESTINATION_UNITS");
  // sourceZatoshis = ceil(destWei * n * 1e8 / (1e18 * d)), mirroring productionPrice.
  return (
    (destinationUnits * n * 100000000n + 10n ** 18n * d - 1n) / (10n ** 18n * d)
  );
}

export function buildSingleOperatorPilotPriceStatement(
  operator: string,
  quoteContext: string,
  observations: PilotMarketObservation[],
  now: number,
  expires: number,
  maximumSpreadBps = DEFAULT_MAX_SPREAD_BPS,
  profile?: ProductionProfile,
): SingleOperatorPilotPriceStatement {
  if (!operator.trim()) throw Error("PILOT_PRICE_OPERATOR_REQUIRED");
  if (!/^[a-f0-9]{64}$/.test(quoteContext))
    throw Error("PILOT_PRICE_QUOTE_CONTEXT_REQUIRED");
  if (!Number.isSafeInteger(now)) throw Error("PILOT_PRICE_NOW_INVALID");
  if (
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires >
      now +
        (profile
          ? pilotQuoteMaximumSeconds(profile, now)
          : MAX_EXPIRY_WINDOW_SECONDS)
  )
    throw Error("PILOT_PRICE_EXPIRY_INVALID");
  const { numerator, denominator } = validatePilotObservations(
    observations,
    now,
    maximumSpreadBps,
  );
  return {
    version: 1,
    policy: PILOT_PRICING_POLICY,
    operator: operator.trim(),
    pair: "ETH/ZEC",
    numerator,
    denominator,
    at: now,
    expires,
    network: "base-mainnet",
    quoteContext,
    observations: observations.map((o) => ({
      ...o,
      provider: o.provider.trim(),
    })),
  };
}

export function signSingleOperatorPilotPrice(
  statement: SingleOperatorPilotPriceStatement,
  privateKey: Parameters<typeof sign>[2],
): { signature: string } {
  return {
    signature: sign(
      null,
      Buffer.from(JSON.stringify(statement)),
      privateKey,
    ).toString("base64"),
  };
}

export function verifySingleOperatorPilotPrice(
  profile: ProductionProfile,
  price: SingleOperatorPilotPrice,
  quoteContext: string,
  destinationUnits: bigint,
  now = Math.floor(Date.now() / 1000),
): {
  sourceZatoshis: string;
  expires: number;
  confidence: typeof PILOT_PRICING_POLICY;
} {
  if (!singleDevicePilotActive(profile, now))
    throw Error("SINGLE_OPERATOR_PILOT_PRICING_REQUIRES_ACTIVE_PILOT");
  const authority = profile.executionAuthority;
  if (!authority) throw Error("PILOT_PRICE_IDENTITY_REQUIRED");
  const s = price.statement;
  const maximumWindow = pilotQuoteMaximumSeconds(profile, now);
  if (
    s.version !== 1 ||
    s.policy !== PILOT_PRICING_POLICY ||
    s.pair !== "ETH/ZEC" ||
    s.network !== "base-mainnet" ||
    s.operator !== authority.identity ||
    s.quoteContext !== quoteContext ||
    !Number.isSafeInteger(s.at) ||
    !Number.isSafeInteger(s.expires) ||
    s.at > now + 5 ||
    now - s.at > (maximumWindow === 300 ? 300 : MAX_OBSERVATION_AGE_SECONDS) ||
    s.expires <= now ||
    s.expires - s.at > maximumWindow
  )
    throw Error("PILOT_PRICE_STATEMENT_INVALID");
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(authority.publicKey);
    if (key.asymmetricKeyType !== "ed25519")
      throw Error("PILOT_PRICE_IDENTITY_NOT_ED25519");
  } catch {
    throw Error("PILOT_PRICE_IDENTITY_INVALID");
  }
  if (
    !verify(
      null,
      Buffer.from(JSON.stringify(s)),
      key,
      Buffer.from(price.signature, "base64"),
    )
  )
    throw Error("PILOT_PRICE_SIGNATURE_INVALID");
  const { numerator, denominator } = validatePilotObservations(
    s.observations,
    s.at,
    DEFAULT_MAX_SPREAD_BPS,
  );
  if (numerator !== s.numerator || denominator !== s.denominator)
    throw Error("PILOT_PRICE_RATE_MISMATCH");
  const sourceZatoshis = pilotPriceSourceZatoshis(
    s.numerator,
    s.denominator,
    destinationUnits,
  );
  return {
    sourceZatoshis: sourceZatoshis.toString(),
    expires: s.expires,
    confidence: PILOT_PRICING_POLICY,
  };
}

export { hash as pilotPriceDigest };
