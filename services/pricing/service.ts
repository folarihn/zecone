import { CoinbasePrices, KrakenPrices } from "./sources.ts";
import { reference, type Reference } from "./reference.ts";
let cached: { zec: Reference; eth: Reference } | undefined;
let pending: Promise<{ zec: Reference; eth: Reference }> | undefined;
export async function marketReferences() {
  const now = () => Math.floor(Date.now() / 1000);
  if (
    cached &&
    now() - cached.zec.at < 30 &&
    now() < Math.min(cached.zec.expires, cached.eth.expires)
  )
    return cached;
  if (pending) return pending;
  pending = (async () => {
    const sources = [new CoinbasePrices(), new KrakenPrices()];
    const [zec, eth] = await Promise.all([
      reference("ZEC", sources, now),
      reference("ETH", sources, now),
    ]);
    cached = { zec, eth };
    return cached;
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}
