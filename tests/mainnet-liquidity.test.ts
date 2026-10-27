import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allocateNotes,
  payoutCapacity,
  relayerAccounting,
  replenishmentRequired,
  spendableZec,
  summarizeSettlements,
  sumReceivedNotes,
  type Settlement,
  type ZecNote,
} from "../services/settlement/mainnet-liquidity.ts";

const note = (
  key: string,
  zatoshis: number,
  spent = false,
  allocated = false,
): ZecNote => ({
  key,
  zatoshis: BigInt(zatoshis),
  spent,
  allocated,
});

test("duplicate deposits are counted once", () => {
  const notes = [
    { key: "tx:4:0", zatoshis: 645937n },
    { key: "tx:4:0", zatoshis: 645937n },
    { key: "tx2:3:1", zatoshis: 100000n },
  ];
  assert.equal(sumReceivedNotes(notes), 745937n);
});

test("double-counted settlements are rejected by order id", () => {
  const settlements: Settlement[] = [
    {
      orderId: "a",
      state: "finalized",
      maximumDebit: 100n,
      transactionId: null,
    },
    {
      orderId: "a",
      state: "finalized",
      maximumDebit: 100n,
      transactionId: null,
    },
    { orderId: "b", state: "claimed", maximumDebit: 50n, transactionId: null },
  ];
  const summary = summarizeSettlements(settlements);
  assert.equal(summary.finalized, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.totalMaximumDebit, 150n);
});

test("pending versus finalized payouts are distinguished", () => {
  const settlements: Settlement[] = [
    { orderId: "a", state: "finalized", maximumDebit: 1n, transactionId: null },
    { orderId: "b", state: "broadcast", maximumDebit: 2n, transactionId: null },
    { orderId: "c", state: "uncertain", maximumDebit: 3n, transactionId: null },
    { orderId: "d", state: "claimed", maximumDebit: 4n, transactionId: null },
  ];
  const summary = summarizeSettlements(settlements);
  assert.equal(summary.finalized, 1);
  assert.equal(summary.pending, 3);
});

test("incorrect balances and overdraft fail closed", () => {
  assert.throws(() => relayerAccounting(100n, 60n, 50n), /OVERDRAWN/);
  const ok = relayerAccounting(
    3600000000000000n,
    3284955372432969n,
    126403760272n,
  );
  assert.equal(ok.remainingWei, 314918223806759n);
  assert.throws(() => relayerAccounting(-1n, 0n, 0n), /INVALID_FUNDED_WEI/);
});

test("insufficient relayer liquidity yields zero capacity", () => {
  assert.equal(payoutCapacity(0n, 3600000000000000n), 0n);
  assert.equal(payoutCapacity(3599999999999999n, 3600000000000000n), 0n);
  assert.equal(payoutCapacity(7200000000000000n, 3600000000000000n), 2n);
});

test("watch-only wallets have zero spendable ZEC regardless of note state", () => {
  const notes = [note("a", 645937), note("b", 100000, false)];
  assert.equal(spendableZec(notes, false), 0n);
  assert.equal(spendableZec(notes, true), 745937n);
  assert.equal(spendableZec([note("a", 645937, true)], true), 0n); // spent note
});

test("missing spending authority never yields spendable ZEC", () => {
  assert.equal(spendableZec([note("a", 999999)], false), 0n);
});

test("allocation and unallocation are exact and deduplicated", () => {
  const notes = [
    note("a", 100, false, true),
    note("a", 100, false, true), // duplicate key, same status — counted once
    note("b", 200, false, true),
    note("c", 300),
  ];
  const { allocated, unallocated } = allocateNotes(notes);
  assert.equal(allocated, 300n);
  assert.equal(unallocated, 300n);
});

test("replenishment requirement is the shortfall only", () => {
  assert.equal(
    replenishmentRequired(314918223806759n, 3600000000000000n),
    3285081776193241n,
  );
  assert.equal(replenishmentRequired(3600000000000000n, 3600000000000000n), 0n);
  assert.equal(replenishmentRequired(4000000000000000n, 3600000000000000n), 0n);
});
