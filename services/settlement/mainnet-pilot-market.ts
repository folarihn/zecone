import {
  validatePilotObservations,
  type PilotMarketObservation,
  type SingleOperatorPilotPriceStatement,
} from "./mainnet-pilot-pricing.ts";
import {
  singleDevicePilotActive,
  pilotQuoteMaximumSeconds,
  type ProductionProfile,
} from "./production-safety.ts";
import {
  assertMainnetQuote,
  type MainnetQuote,
  type MainnetQuoteInput,
} from "./mainnet-quote.ts";
import type { MainnetTransferTerms } from "./mainnet-transfer.ts";

export async function fetchPilotMarketObservations(
  fetcher: typeof fetch = fetch,
  clock = () => Math.floor(Date.now() / 1000),
): Promise<PilotMarketObservation[]> {
  const PROVIDERS = {
    coingecko: async () => {
      const r = await fetcher(
        "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,zcash&vs_currencies=usd",
        {
          signal: AbortSignal.timeout(15000),
          cache: "no-store",
          redirect: "error",
        },
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
      const eth = await fetcher(
        "https://api.coinpaprika.com/v1/tickers/eth-ethereum?quotes=USD",
        {
          signal: AbortSignal.timeout(15000),
          cache: "no-store",
          redirect: "error",
        },
      );
      const zec = await fetcher(
        "https://api.coinpaprika.com/v1/tickers/zec-zcash?quotes=USD",
        {
          signal: AbortSignal.timeout(15000),
          cache: "no-store",
          redirect: "error",
        },
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

  const at = clock();
  const [cg, cp] = await Promise.all([
    PROVIDERS.coingecko(),
    PROVIDERS.coinpaprika(),
  ]);
  const observations = [
    { provider: "coingecko", ...cg, at },
    { provider: "coinpaprika", ...cp, at },
  ];
  validatePilotObservations(observations, clock());
  return observations;
}

export function assertPilotMarketMovement(
  profile: ProductionProfile,
  original: SingleOperatorPilotPriceStatement,
  current: PilotMarketObservation[],
  now = Math.floor(Date.now() / 1000),
) {
  if (
    !singleDevicePilotActive(profile, now) ||
    pilotQuoteMaximumSeconds(profile, now) !== 300
  )
    throw Error("EXTENDED_PILOT_MARKET_POLICY_REQUIRED");
  if (original.expires <= now || original.expires - original.at > 300)
    throw Error("PILOT_PRICE_STATEMENT_INVALID");
  const fresh = validatePilotObservations(current, now);
  const allowed = ["coingecko", "coinpaprika"];
  for (const rows of [original.observations, current])
    if (
      rows.length !== 2 ||
      rows.some((o) => !allowed.includes(o.provider)) ||
      new Set(rows.map((o) => o.provider)).size !== 2
    )
      throw Error("PILOT_PRICE_SOURCE_MISMATCH");
  const tolerance = profile.pilot?.marketMovementBps ?? 200;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > 200)
    throw Error("PILOT_PRICE_TOLERANCE_INVALID");
  const baseline = BigInt(original.numerator) * BigInt(fresh.denominator),
    latest = BigInt(fresh.numerator) * BigInt(original.denominator),
    delta = baseline > latest ? baseline - latest : latest - baseline;
  if (delta * 10000n > baseline * BigInt(tolerance))
    throw Error("PILOT_MARKET_PRICE_MOVED");
  return {
    checkedAt: now,
    maximumMovementBps: tolerance,
    numerator: fresh.numerator,
    denominator: fresh.denominator,
  };
}

export async function verifyPilotBroadcastMarket(
  profile: ProductionProfile,
  terms: MainnetTransferTerms,
  context: { quote: MainnetQuote; input: MainnetQuoteInput } | undefined,
  fetcher: typeof fetch = fetch,
  clock = () => Math.floor(Date.now() / 1000),
) {
  if (pilotQuoteMaximumSeconds(profile, clock()) !== 300) return;
  if (
    !context?.input.pilotPrice ||
    context.quote.quoteDigest !== terms.quoteDigest ||
    context.quote.destinationUnits !== terms.amount ||
    BigInt(context.quote.sourceZatoshis) > BigInt(terms.sourceZatoshis) ||
    context.quote.maximumDestinationDebit !== terms.maximumDestinationDebit
  )
    throw Error("PILOT_BROADCAST_MARKET_CONTEXT_REQUIRED");
  assertMainnetQuote(context.quote, { ...context.input, profile }, clock());
  const observations = await fetchPilotMarketObservations(fetcher, clock);
  const result = assertPilotMarketMovement(
    profile,
    context.input.pilotPrice.statement,
    observations,
    clock(),
  );
  // Network reads must not allow an approval to cross its deadline.
  assertMainnetQuote(context.quote, { ...context.input, profile }, clock());
  return result;
}
