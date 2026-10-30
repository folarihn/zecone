// Real read-only HTTP market-data probe; never creates a quote/payment/order.
import { writeFileSync } from "node:fs";
import { CoinbasePrices, KrakenPrices } from "../services/pricing/sources.ts";
import { reference } from "../services/pricing/reference.ts";
const results = [];
for (const asset of ["ZEC", "ETH"] as const) {
  try {
    results.push({
      asset,
      status: "verified-reference",
      reference: await reference(
        asset,
        [new CoinbasePrices(), new KrakenPrices()],
        () => Math.floor(Date.now() / 1000),
      ),
    });
  } catch (e) {
    results.push({
      asset,
      status: "unavailable",
      reason: e instanceof Error ? e.message : "price_source_unavailable",
    });
  }
}
const report = {
  at: new Date().toISOString(),
  kind: "real-read-only-market-data",
  testnetRedemption: false,
  paymentsCreated: 0,
  results,
};
writeFileSync(
  "docs/phase5-evidence/market-data.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
