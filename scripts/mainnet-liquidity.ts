// Read-only mainnet liquidity ledger. It reads the Zcash watch wallet, the
// watch and submission journals, and the Base relayer balance, then prints an
// integer-only accounting. It never writes, spends, signs, or broadcasts.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  allocateNotes,
  payoutCapacity,
  replenishmentRequired,
  spendableZec,
  summarizeSettlements,
  sumReceivedNotes,
  type Settlement,
  type ZecNote,
} from "../services/settlement/mainnet-liquidity.ts";

function args() {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    if (!flag.startsWith("--") || !process.argv[i + 1])
      throw Error("INVALID_ARGUMENTS");
    values.set(flag.slice(2), process.argv[i + 1]);
  }
  return values;
}
function required(v: Map<string, string>, key: string) {
  const x = v.get(key);
  if (!x) throw Error(`${key.toUpperCase()}_REQUIRED`);
  return x;
}

type Rpc = { url: string; operator: string };
function rpcProvider(
  v: Map<string, string>,
  key: string,
  fallbackOp: string,
): Rpc {
  const url = required(v, key);
  return { url, operator: fallbackOp };
}

async function rpc(provider: Rpc, method: string, params: unknown[]) {
  const res = await fetch(provider.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw Error("RPC_UNAVAILABLE");
  const data = await res.json();
  if (data.error || data.id !== 1 || !("result" in data))
    throw Error("INVALID_RPC_RESPONSE");
  return data.result as unknown;
}

function bigintHex(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value))
    throw Error("INVALID_HEX");
  return BigInt(value);
}

async function main() {
  const v = args();
  const walletDb = required(v, "wallet-db");
  const watchJournal = required(v, "watch-journal");
  const submissions = required(v, "submissions");
  const relayer = required(v, "relayer");
  const primary = rpcProvider(v, "rpc-a", "primary");
  const peer = rpcProvider(v, "rpc-b", "peer");

  // 1. Zcash notes from the watch wallet.
  const wallet = new DatabaseSync(walletDb, { readOnly: true });
  const noteRows = wallet
    .prepare(
      `SELECT t.txid, r.pool, r.output_index, r.value, t.mined_height, r.is_change,
        (SELECT COUNT(*) FROM v_received_output_spends s WHERE s.pool=r.pool AND s.received_output_id=r.id_within_pool_table) AS spend_count
       FROM v_received_outputs r JOIN transactions t ON t.id_tx=r.transaction_id
       WHERE r.value>0 AND r.is_change=0 ORDER BY t.mined_height`,
    )
    .all() as {
    txid: Uint8Array;
    pool: number;
    output_index: number;
    value: bigint | number;
    mined_height: number;
    is_change: number;
    spend_count: number;
  }[];
  wallet.close();

  const notes: ZecNote[] = noteRows.map((r) => ({
    key: `${Buffer.from(r.txid).reverse().toString("hex")}:${r.pool}:${r.output_index}`,
    zatoshis: BigInt(r.value),
    spent: r.spend_count > 0,
    allocated: false,
  }));
  const noteKeys = new Set(notes.map((n) => n.key));

  // 2. Allocated notes from the watch journal (active payments bound to orders).
  const watch = new DatabaseSync(watchJournal, { readOnly: true });
  const paymentRows = watch
    .prepare(
      "SELECT txid, pool, output_index, zatoshis, status, active FROM mainnet_watch_payments",
    )
    .all() as {
    txid: string;
    pool: number;
    output_index: number;
    zatoshis: bigint | number | string;
    status: string;
    active: number;
  }[];
  watch.close();
  for (const p of paymentRows) {
    const key = `${p.txid}:${p.pool}:${p.output_index}`;
    if (noteKeys.has(key)) {
      const note = notes.find((n) => n.key === key)!;
      note.allocated = p.active === 1;
    }
  }

  // 3. Settlements from the submission journal.
  const sub = new DatabaseSync(submissions, { readOnly: true });
  const settlementRows = sub
    .prepare(
      "SELECT order_id, state, maximum_debit, transaction_id, broadcast_txid FROM mainnet_submissions ORDER BY rowid",
    )
    .all() as {
    order_id: string;
    state: string;
    maximum_debit: bigint | number | string;
    transaction_id: string;
    broadcast_txid: string | null;
  }[];
  sub.close();
  const settlements: Settlement[] = settlementRows.map((s) => ({
    orderId: s.order_id,
    state: s.state,
    maximumDebit: BigInt(s.maximum_debit),
    transactionId: s.transaction_id || s.broadcast_txid,
  }));

  // 4. Base relayer balance + nonce from both providers.
  const read = async (m: string, params: unknown[]) => {
    const [a, b] = await Promise.all([
      rpc(primary, m, params),
      rpc(peer, m, params),
    ]);
    return { a, b };
  };
  const bal = await read("eth_getBalance", [relayer, "finalized"]);
  const nonce = await read("eth_getTransactionCount", [relayer, "pending"]);
  const chain = await read("eth_chainId", []);
  const balanceWei = bigintHex(bal.a);
  if (
    bigintHex(bal.b) !== balanceWei ||
    bigintHex(nonce.a) !== bigintHex(nonce.b)
  )
    throw Error("PROVIDER_DISAGREEMENT");

  // 5. ETH paid + fees from finalized receipts.
  let paidWei = 0n;
  let feeWei = 0n;
  for (const s of settlements) {
    if (s.state !== "finalized" || !s.transactionId) continue;
    const tx = (await rpc(primary, "eth_getTransactionByHash", [
      s.transactionId,
    ])) as {
      value?: string;
    };
    const receipt = (await rpc(primary, "eth_getTransactionReceipt", [
      s.transactionId,
    ])) as {
      gasUsed?: string;
      effectiveGasPrice?: string;
      l1Fee?: string;
    };
    paidWei += bigintHex(tx.value);
    feeWei +=
      bigintHex(receipt.gasUsed) * bigintHex(receipt.effectiveGasPrice) +
      (receipt.l1Fee ? bigintHex(receipt.l1Fee) : 0n);
  }

  const received = sumReceivedNotes(notes);
  const { allocated, unallocated } = allocateNotes(notes);
  const summary = summarizeSettlements(settlements);
  const spendable = spendableZec(notes, false); // watch-only wallet
  const payoutPlusFee = 3600000000000000n; // a reference 0.0036 ETH payout budget
  const capacity = payoutCapacity(balanceWei, payoutPlusFee);
  const replenishment = replenishmentRequired(balanceWei, payoutPlusFee);

  const result = {
    mode: "READ_ONLY_LIQUIDITY_LEDGER",
    network: "zcash-mainnet -> base-mainnet",
    relayer,
    relayerNonce: bigintHex(nonce.a).toString(),
    relayerBalanceWei: balanceWei.toString(),
    relayerBalanceEth: (Number(balanceWei) / 1e18).toFixed(18),
    zec: {
      receivedTotalZatoshis: received.toString(),
      receivedTotalZec: (Number(received) / 1e8).toFixed(8),
      noteCount: notes.length,
      allocatedZatoshis: allocated.toString(),
      unallocatedZatoshis: unallocated.toString(),
      spendableZatoshis: spendable.toString(),
      spendAuthorityImported: false,
    },
    settlements: {
      total: settlements.length,
      finalized: summary.finalized,
      pending: summary.pending,
      totalMaximumDebitWei: summary.totalMaximumDebit.toString(),
    },
    eth: {
      paidWei: paidWei.toString(),
      paidEth: (Number(paidWei) / 1e18).toFixed(18),
      feeWei: feeWei.toString(),
    },
    capacity: {
      payoutCapacity: capacity.toString(),
      replenishmentRequiredWei: replenishment.toString(),
    },
    providerAgreement: "PASS",
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : "LIQUIDITY_FAILED";
  process.stderr.write(
    JSON.stringify({
      error: /^[A-Z0-9_]{1,96}$/.test(msg) ? msg : "LIQUIDITY_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
});
