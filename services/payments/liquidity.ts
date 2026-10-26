// Relayer liquidity guard for payment creation.
//
// A quote is only issued if the prefunded Base relayer can cover it together
// with every payout already promised to open payments. The available balance is
// an operator-supplied snapshot (ZECONE_RELAYER_AVAILABLE_WEI) — this process
// holds no relayer key and performs no RPC balance read, so the guard is
// conservative bookkeeping, not proof of funds. Integer wei only.
import type { PaymentStore } from "./store.ts";

const OPEN_STATES = [
  "CREATED",
  "QUOTED",
  "AWAITING_PAYMENT",
  "PAYMENT_DETECTED",
  "VERIFYING",
  "ZEC_CONFIRMED",
  "PAYOUT_PENDING",
  "PAYOUT_SUBMITTED",
  "MANUAL_REVIEW",
];

export class InsufficientLiquidityError extends Error {
  readonly code = "insufficient_liquidity";
  constructor(
    readonly requiredWei: bigint,
    readonly availableWei: bigint,
  ) {
    super("relayer liquidity is insufficient for this payout");
    this.name = "InsufficientLiquidityError";
  }
}

/** Sum of ETH payouts promised to open (not completed/expired/failed) payments in `mode`. */
export function committedWei(store: PaymentStore, mode: "demo" | "monitor" | "live"): bigint {
  const rows = store.db
    .prepare(
      `SELECT quote_json FROM payments WHERE mode=? AND quote_json IS NOT NULL AND state IN (${OPEN_STATES.map(() => "?").join(",")})`,
    )
    .all(mode, ...OPEN_STATES) as { quote_json: string }[];
  let total = 0n;
  for (const r of rows) total += BigInt((JSON.parse(r.quote_json) as { ethPayoutWei: string }).ethPayoutWei);
  return total;
}

export function assertLiquidity(
  store: PaymentStore,
  mode: "demo" | "monitor" | "live",
  payoutWei: bigint,
  availableWei: bigint,
): { committedWei: bigint; remainingWei: bigint } {
  if (payoutWei <= 0n) throw new InsufficientLiquidityError(payoutWei, availableWei);
  const committed = committedWei(store, mode);
  if (committed + payoutWei > availableWei) throw new InsufficientLiquidityError(committed + payoutWei, availableWei);
  return { committedWei: committed, remainingWei: availableWei - committed - payoutWei };
}
