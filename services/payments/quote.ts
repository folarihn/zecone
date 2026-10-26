// Quote engine. Produces an exact, expiry-bound ZEC amount and Base ETH payout
// for a requested USD amount.
//
// Demo mode uses a fixed, clearly-labeled DEMO_RATE and never creates a real
// financial obligation. Live mode is disabled by default: the real quote path
// requires a configured price authority and is gated behind `liveEnabled`.
import { randomUUID } from "node:crypto";
import { MoneyError, convertUnits, formatUnits, nonNegativeUnits } from "./money.ts";
import type { Quote } from "./types.ts";

// Fixed demo rate: 1 ZEC = 50.00 USD (2dp). This is a *placeholder* for the
// demo checkout and is explicitly not a live market rate.
export const DEMO_ZEC_USD = { numerator: 50_00n, denominator: 1n, decimals: 2 };
// Demo ZEC->ETH rate derived from the recorded mainnet settlement:
// 645,937 zat (0.00645937 ZEC) -> 0.003284955372432969 ETH.
// Rounded to a rational approximation for exact bigint math.
export const DEMO_ZEC_ETH = {
  numerator: 3284955372432969n,
  denominator: 645_937n,
  // scale: wei per zatoshi
};

export const ZAT_PER_ZEC = 10n ** 8n;
export const WEI_PER_ETH = 10n ** 18n;

export interface QuoteInput {
  amountUsd: string;
  payoutChain: "base";
  ttlSeconds?: number;
  now?: number;
}

export interface QuoteEngine {
  enabled: boolean; // live quoting is disabled by default
  quote(input: QuoteInput): Quote;
}

export class DemoQuoteEngine implements QuoteEngine {
  readonly enabled = false;
  constructor(
    private readonly ttlSeconds = 15 * 60,
    private readonly zecUsd = DEMO_ZEC_USD,
    private readonly zecEth = DEMO_ZEC_ETH,
  ) {}
  quote(input: QuoteInput): Quote {
    if (input.payoutChain !== "base") throw new MoneyError("only base is supported", "invalid_amount");
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const usdCents = nonNegativeUnits(input.amountUsd, "usd");
    // ZEC amount = USD cents / (50.00 USD per ZEC) -> zatoshi via rational math.
    // amountUsd (cents) * 10^8 zat / ZEC  /  (zecUsd numerator cents per ZEC)
    const zat = (usdCents * ZAT_PER_ZEC * this.zecUsd.denominator) / this.zecUsd.numerator;
    if (zat <= 0n) throw new MoneyError("amount too small", "invalid_amount");
    // ETH payout = zat * (ETH wei per zat)
    const wei = (zat * this.zecEth.numerator) / this.zecEth.denominator;
    const id = `q_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const expiresAt = now + this.ttlSeconds;
    return {
      id,
      network: "zcash-mainnet",
      payoutChain: "base",
      amountUsd: input.amountUsd,
      zecAmount: formatUnits(zat, "zec"),
      zecAmountZat: zat.toString(),
      ethPayout: formatUnits(wei, "eth"),
      ethPayoutWei: wei.toString(),
      feeZat: "10000", // ZIP-317 fee is handled on the Zcash leg; recorded for transparency
      rate: {
        numerator: this.zecEth.numerator.toString(),
        denominator: this.zecEth.denominator.toString(),
      },
      rateSource: "demo-fixed",
      expiresAt,
      createdAt: now,
    };
  }
}

export function convertUsdToWei(usdCents: bigint, rate: { numerator: bigint; denominator: bigint }): bigint {
  return convertUnits(usdCents, rate);
}
