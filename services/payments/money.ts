// Decimal-safe financial arithmetic. No floating point is ever used for money:
// amounts are parsed to integer units of the smallest denomination (bigint) and
// formatted back to fixed-point strings on the boundary.
//
// Denominations:
//   ZEC   -> 8 decimals  (zatoshis)
//   ETH   -> 18 decimals (wei)
//   USD   -> 2 decimals  (cents)

export type Currency = "zec" | "eth" | "usd";

export const DECIMALS: Record<Currency, number> = {
  zec: 8,
  eth: 18,
  usd: 2,
} as const;

const MAX_DIGITS: Record<Currency, number> = {
  // 21e6 ZEC max supply -> 21_000_000_000_000_000 zatoshis (16 digits)
  zec: 18,
  // ~1.2e8 ETH * 1e18 wei (27 digits)
  eth: 30,
  usd: 14,
} as const;

export class MoneyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_amount"
      | "too_many_decimals"
      | "overflow"
      | "negative",
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Parse a fixed-point decimal string into integer smallest-denomination units. */
export function parseUnits(value: string, currency: Currency): bigint {
  if (typeof value !== "string") throw new MoneyError("amount must be a string", "invalid_amount");
  const s = value.trim();
  if (s === "") throw new MoneyError("empty amount", "invalid_amount");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new MoneyError("invalid decimal amount", "invalid_amount");
  const [whole, frac = ""] = s.split(".");
  const decimals = DECIMALS[currency];
  if (frac.length > decimals)
    throw new MoneyError(`at most ${decimals} decimals for ${currency}`, "too_many_decimals");
  const fracPadded = frac.padEnd(decimals, "0");
  const digits = (whole === "" ? "0" : whole) + (fracPadded === "" ? "" : fracPadded);
  const clean = digits.replace(/^0+/, "") || "0";
  const magnitude = BigInt(clean === "" ? "0" : clean);
  if (magnitude.toString().length > MAX_DIGITS[currency])
    throw new MoneyError(`${currency} amount overflow`, "overflow");
  return magnitude;
}

/** Format integer smallest-denomination units into a fixed-point string. */
export function formatUnits(value: bigint, currency: Currency): string {
  const decimals = DECIMALS[currency];
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  const fracTrimmed = frac.replace(/0+$/, "");
  const result = fracTrimmed ? `${whole}.${fracTrimmed}` : whole;
  return `${negative ? "-" : ""}${result}`;
}

/** Ensure a non-negative amount and return its integer units. */
export function nonNegativeUnits(value: string, currency: Currency): bigint {
  const units = parseUnits(value, currency);
  if (units < 0n) throw new MoneyError("amount must be non-negative", "negative");
  return units;
}

export function addUnits(a: bigint, b: bigint): bigint {
  return a + b;
}

export function subUnits(a: bigint, b: bigint): bigint {
  return a - b;
}

/**
 * Convert an integer amount from one denomination to another using a rational
 * rate expressed as { numerator, denominator } (both bigint). This is exact:
 * (amount * numerator) / denominator with rounding down, no floats.
 */
export function convertUnits(
  amount: bigint,
  rate: { numerator: bigint; denominator: bigint },
): bigint {
  if (rate.denominator <= 0n) throw new MoneyError("invalid rate denominator", "invalid_amount");
  return (amount * rate.numerator) / rate.denominator;
}
