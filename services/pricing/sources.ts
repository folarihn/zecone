import {
  decimalUsd,
  type Asset,
  type PriceSource,
  type Price,
} from "./reference.ts";
const hosts = new Set([
  "api.kraken.com",
  "api.exchange.coinbase.com",
  "api.coingecko.com",
]);
async function json(url: string, headers: Record<string, string> = {}) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    !hosts.has(u.hostname) ||
    u.username ||
    u.password ||
    u.port
  )
    throw Error("price_endpoint");
  try {
    const response = await fetch(u, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || !response.body) throw Error();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const part of response.body) {
      length += part.length;
      if (length > 262144) throw Error();
      chunks.push(part);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Error("price_source_unavailable");
  }
}
const now = () => Math.floor(Date.now() / 1000);
export class CoinbasePrices implements PriceSource {
  id = "coinbase";
  async fetch(asset: Asset): Promise<Price> {
    if (!["ZEC", "ETH"].includes(asset)) throw Error("unsupported_price_asset");
    const product = `${asset}-USD`,
      meta = await json(
        `https://api.exchange.coinbase.com/products/${product}`,
      );
    if (
      meta.id !== product ||
      meta.base_currency !== asset ||
      meta.quote_currency !== "USD" ||
      meta.status !== "online" ||
      meta.trading_disabled === true
    )
      throw Error("price_product_unavailable");
    const t = await json(
      `https://api.exchange.coinbase.com/products/${product}/ticker`,
    );
    return {
      source: this.id,
      asset,
      usdE8: decimalUsd(t.price),
      sourceAt: Math.floor(Date.parse(t.time) / 1000),
      receivedAt: now(),
    };
  }
}
export class KrakenPrices implements PriceSource {
  id = "kraken";
  async fetch(asset: Asset): Promise<Price> {
    if (!["ZEC", "ETH"].includes(asset)) throw Error("unsupported_price_asset");
    const pair = `${asset}USD`,
      meta = await json(
        `https://api.kraken.com/0/public/AssetPairs?pair=${pair}`,
      );
    const pairs = Object.entries(meta.result ?? {});
    if (!Array.isArray(meta.error) || meta.error.length || pairs.length !== 1)
      throw Error("price_product_unavailable");
    const [name, p] = pairs[0] as [string, any];
    if (
      p.altname !== pair ||
      p.base !== `X${asset}` ||
      p.quote !== "ZUSD" ||
      p.status !== "online"
    )
      throw Error("price_product_unavailable");
    const trades = await json(
      `https://api.kraken.com/0/public/Trades?pair=${pair}&count=1`,
    );
    const rows = trades.result?.[name];
    if (
      !Array.isArray(trades.error) ||
      trades.error.length ||
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      typeof rows[0][2] !== "number"
    )
      throw Error("price_trade_unavailable");
    return {
      source: this.id,
      asset,
      usdE8: decimalUsd(rows[0][0]),
      sourceAt: Math.floor(rows[0][2]),
      receivedAt: now(),
    };
  }
}
export class CoinGeckoPrices implements PriceSource {
  id = "coingecko";
  constructor(private readonly demoKey: string) {
    if (!demoKey || demoKey.length > 512)
      throw Error("coingecko_demo_key_required");
  }
  async fetch(asset: Asset): Promise<Price> {
    if (!["ZEC", "ETH"].includes(asset)) throw Error("unsupported_price_asset");
    const id = asset === "ZEC" ? "zcash" : "ethereum";
    const data = await json(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_last_updated_at=true&precision=8`,
      { "x-cg-demo-api-key": this.demoKey },
    );
    const p = data[id];
    return {
      source: this.id,
      asset,
      usdE8: decimalUsd(String(p?.usd)),
      sourceAt: p?.last_updated_at,
      receivedAt: now(),
    };
  }
}
