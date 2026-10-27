// Read-only liquidity accounting for the mainnet pilot. No signing, spending,
// broadcast, or wallet mutation. All arithmetic is integer (BigInt); Zcash
// amounts are in zatoshis and Base amounts in wei. A verified note is never
// treated as spendable here — spendability requires a separate spend-authority
// wallet plus an unspent, finalized note, neither of which this module asserts.
export type ZecNote = {
  key: string;
  zatoshis: bigint;
  spent: boolean;
  allocated: boolean;
};

export type Settlement = {
  orderId: string;
  state: string;
  maximumDebit: bigint;
  transactionId: string | null;
};

export type RelayerLedger = {
  fundedWei: bigint;
  paidWei: bigint;
  feeWei: bigint;
  remainingWei: bigint;
};

const integer = (v: bigint, label: string) => {
  if (typeof v !== "bigint" || v < 0n) throw Error(`INVALID_${label}`);
  return v;
};

// Sum distinct notes by key; a duplicate key is counted exactly once.
export function sumReceivedNotes(
  notes: readonly { key: string; zatoshis: bigint }[],
): bigint {
  const seen = new Set<string>();
  let total = 0n;
  for (const note of notes) {
    integer(note.zatoshis, "NOTE_ZATOSHIS");
    if (!note.key) throw Error("NOTE_KEY_REQUIRED");
    if (seen.has(note.key)) continue;
    seen.add(note.key);
    total += note.zatoshis;
  }
  return total;
}

// Split notes into allocated (bound to a settlement) and unallocated, deduped.
export function allocateNotes(notes: readonly ZecNote[]): {
  allocated: bigint;
  unallocated: bigint;
} {
  const seen = new Set<string>();
  let allocated = 0n;
  let unallocated = 0n;
  for (const note of notes) {
    integer(note.zatoshis, "NOTE_ZATOSHIS");
    if (!note.key) throw Error("NOTE_KEY_REQUIRED");
    if (seen.has(note.key)) continue;
    seen.add(note.key);
    if (note.allocated) allocated += note.zatoshis;
    else unallocated += note.zatoshis;
  }
  return { allocated, unallocated };
}

// Whether any note is actually spendable: requires it be unspent AND that a
// spend-authority wallet exists. This module never knows the latter, so the
// caller supplies `hasSpendAuthority`. Watch-only wallets report false.
export function spendableZec(
  notes: readonly ZecNote[],
  hasSpendAuthority: boolean,
): bigint {
  if (!hasSpendAuthority) return 0n;
  const seen = new Set<string>();
  let total = 0n;
  for (const note of notes) {
    integer(note.zatoshis, "NOTE_ZATOSHIS");
    if (!note.key) throw Error("NOTE_KEY_REQUIRED");
    if (seen.has(note.key)) continue;
    seen.add(note.key);
    if (!note.spent) total += note.zatoshis;
  }
  return total;
}

// Relayer accounting: remaining = funded - paid - fees. Rejects overdraft.
export function relayerAccounting(
  fundedWei: bigint,
  paidWei: bigint,
  feeWei: bigint,
): RelayerLedger {
  integer(fundedWei, "FUNDED_WEI");
  integer(paidWei, "PAID_WEI");
  integer(feeWei, "FEE_WEI");
  if (paidWei + feeWei > fundedWei) throw Error("RELAYER_OVERDRAWN");
  return {
    fundedWei,
    paidWei,
    feeWei,
    remainingWei: fundedWei - paidWei - feeWei,
  };
}

// How many full payouts of (payout + fee) the balance can still cover.
export function payoutCapacity(
  balanceWei: bigint,
  payoutPlusFeeWei: bigint,
): bigint {
  integer(balanceWei, "BALANCE_WEI");
  if (payoutPlusFeeWei <= 0n) throw Error("INVALID_PAYOUT_PLUS_FEE");
  return balanceWei / payoutPlusFeeWei;
}

// Additional wei required to reach a target balance; 0 if already met.
export function replenishmentRequired(
  balanceWei: bigint,
  targetWei: bigint,
): bigint {
  integer(balanceWei, "BALANCE_WEI");
  integer(targetWei, "TARGET_WEI");
  return balanceWei < targetWei ? targetWei - balanceWei : 0n;
}

// Classify a settlement record and aggregate totals without double counting an
// order id.
export function summarizeSettlements(settlements: readonly Settlement[]): {
  finalized: number;
  pending: number;
  totalMaximumDebit: bigint;
} {
  const seen = new Set<string>();
  let finalized = 0;
  let pending = 0;
  let totalMaximumDebit = 0n;
  for (const s of settlements) {
    if (!s.orderId) throw Error("ORDER_ID_REQUIRED");
    if (seen.has(s.orderId)) continue;
    seen.add(s.orderId);
    integer(s.maximumDebit, "MAXIMUM_DEBIT");
    totalMaximumDebit += s.maximumDebit;
    if (s.state === "finalized") finalized += 1;
    else if (["claimed", "broadcast", "uncertain"].includes(s.state))
      pending += 1;
  }
  return { finalized, pending, totalMaximumDebit };
}
