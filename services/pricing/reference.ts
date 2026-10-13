import { digest } from "../settlement/protocol.ts";
export type Asset = "ZEC" | "ETH";
export type Price = {
  source: string;
  asset: Asset;
  usdE8: string;
  sourceAt: number;
  receivedAt: number;
};
export interface PriceSource {
  id: string;
  fetch(asset: Asset): Promise<Price>;
}
export type Reference = {
  asset: Asset;
  usdE8: string;
  at: number;
  expires: number;
  sources: Price[];
  referenceOnly: true;
};
export function decimalUsd(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,8})?$/.test(value)
  )
    throw Error("invalid_price");
  const [whole, frac = ""] = value.split("."),
    n = BigInt(whole) * 100000000n + BigInt(frac.padEnd(8, "0"));
  if (n <= 0n) throw Error("invalid_price");
  return n.toString();
}
function policy(maxAge: number, deviationBps: number) {
  if (
    !Number.isSafeInteger(maxAge) ||
    maxAge < 1 ||
    maxAge > 600 ||
    !Number.isSafeInteger(deviationBps) ||
    deviationBps < 0 ||
    deviationBps > 1000
  )
    throw Error("invalid_price_policy");
}
export function consensus(
  asset: Asset,
  prices: Price[],
  now: number,
  maxAge = 120,
  deviationBps = 300,
): Reference {
  policy(maxAge, deviationBps);
  if (
    !Number.isSafeInteger(now) ||
    prices.length < 2 ||
    prices.length > 8 ||
    new Set(prices.map((p) => p.source)).size !== prices.length
  )
    throw Error("independent_price_sources_required");
  for (const p of prices) {
    if (
      p.asset !== asset ||
      !/^[a-z][a-z0-9-]{1,31}$/.test(p.source) ||
      !/^[1-9][0-9]{0,16}$/.test(p.usdE8) ||
      !Number.isSafeInteger(p.sourceAt) ||
      !Number.isSafeInteger(p.receivedAt) ||
      p.sourceAt > now + 5 ||
      now - p.sourceAt > maxAge ||
      p.receivedAt > now + 5 ||
      now - p.receivedAt > maxAge ||
      p.sourceAt > p.receivedAt + 5
    )
      throw Error("stale_or_invalid_price");
  }
  const sorted = prices
      .map((p) => BigInt(p.usdE8))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    low = sorted[0]!,
    high = sorted.at(-1)!;
  if ((high - low) * 10000n > low * BigInt(deviationBps))
    throw Error("price_source_disagreement");
  const mid = Math.floor(sorted.length / 2),
    median =
      sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
  return {
    asset,
    usdE8: median.toString(),
    at: now,
    expires: Math.min(...prices.map((p) => p.sourceAt + maxAge)),
    sources: prices.map((p) => ({ ...p })),
    referenceOnly: true,
  };
}
export async function reference(
  asset: Asset,
  sources: PriceSource[],
  now: () => number,
  maxAge = 120,
  deviationBps = 300,
) {
  if (
    sources.length < 2 ||
    sources.length > 8 ||
    new Set(sources.map((s) => s.id)).size !== sources.length
  )
    throw Error("independent_price_sources_required");
  // No silent quorum downgrade or fixed-rate fallback when a configured feed fails.
  const prices = await Promise.all(
    sources.map(async (s) => {
      const p = await s.fetch(asset);
      if (p.source !== s.id) throw Error("source_identity");
      return p;
    }),
  );
  return consensus(asset, prices, now(), maxAge, deviationBps);
}
export type ReferenceQuote = {
  version: 1;
  policy: "provider-committed-testnet";
  created: number;
  approveBefore: number;
  executeBefore: number;
  maxReferenceMovementBps: number;
  zec: Reference;
  eth: Reference;
  nativeWei: string;
  gasReserveWei: string;
  providerFeeWei: string;
  referenceZatoshis: string;
  referenceOnly: true;
  digest: string;
};
function uint(v: string) {
  if (!/^(0|[1-9][0-9]{0,36})$/.test(v)) throw Error("invalid_quote_amount");
  return BigInt(v);
}
export function quoteReference(
  nativeWei: string,
  gasReserveWei: string,
  feeBps: number,
  zec: Reference,
  eth: Reference,
  now: number,
  executeBefore: number,
  maxReferenceMovementBps = 300,
): ReferenceQuote {
  if (
    zec.asset !== "ZEC" ||
    eth.asset !== "ETH" ||
    zec.expires <= now ||
    eth.expires <= now ||
    zec.at > now ||
    eth.at > now ||
    !Number.isSafeInteger(feeBps) ||
    feeBps < 0 ||
    feeBps > 1000 ||
    !Number.isSafeInteger(executeBefore) ||
    executeBefore <= now ||
    executeBefore > now + 3600
  )
    throw Error("invalid_quote_terms");
  policy(120, maxReferenceMovementBps);
  const native = uint(nativeWei),
    gas = uint(gasReserveWei),
    fee = (native * BigInt(feeBps) + 9999n) / 10000n;
  const numerator = (native + gas + fee) * BigInt(eth.usdE8) * 100000000n,
    denominator = 1000000000000000000n * BigInt(zec.usdE8),
    zatoshis = (numerator + denominator - 1n) / denominator;
  if (native === 0n || zatoshis <= 0n || zatoshis > 2100000000000000n)
    throw Error("quote_amount_overflow");
  const q = {
    version: 1 as const,
    policy: "provider-committed-testnet" as const,
    created: now,
    approveBefore: Math.min(now + 60, zec.expires, eth.expires),
    executeBefore,
    maxReferenceMovementBps,
    zec,
    eth,
    nativeWei,
    gasReserveWei,
    providerFeeWei: fee.toString(),
    referenceZatoshis: zatoshis.toString(),
    referenceOnly: true as const,
  };
  return { ...q, digest: digest(q) };
}
export function checkQuote(
  q: ReferenceQuote,
  expectedDigest: string,
  now: number,
  currentZec: Reference,
  currentEth: Reference,
  alreadyApproved: boolean,
) {
  const { digest: stored, ...body } = q;
  if (
    stored !== expectedDigest ||
    digest(body) !== stored ||
    now >= q.executeBefore ||
    (!alreadyApproved && now >= q.approveBefore)
  )
    throw Error("quote_expired_or_modified");
  // Provider commitment absorbs post-approval reference movement; never reprice
  // a paid order. Asset availability/minOut/consideration must still be rechecked.
  if (alreadyApproved) return;
  for (const [before, after] of [
    [q.zec, currentZec],
    [q.eth, currentEth],
  ]) {
    if (after.asset !== before.asset || after.expires <= now || after.at > now)
      throw Error("stale_price");
    const a = BigInt(before.usdE8),
      b = BigInt(after.usdE8),
      delta = a > b ? a - b : b - a;
    if (delta * 10000n > a * BigInt(q.maxReferenceMovementBps))
      throw Error("quote_price_moved");
  }
}
