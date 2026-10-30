// Public destination reads only; no source payment IDs, keys or order database.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getAddress, keccak256 } from "viem";
import { providerReserved } from "../services/marketplace/journal.ts";
import { adapterFor } from "../services/evm/adapter.ts";
import { network } from "../services/evm/networks.ts";
import { quoteTransfer } from "../services/evm/transfers.ts";
import {
  nonce,
  type EvmTransferIntent,
} from "../services/settlement/transfers.ts";
const wallets = JSON.parse(readFileSync("docs/PUBLIC_WALLETS.json", "utf8"));
const recipient = getAddress(wallets.base.user),
  relayer = getAddress(wallets.base.relayer);
const results: unknown[] = [];
for (const chainId of [84532, 11155111] as const) {
  const n = network(chainId),
    now = Math.floor(Date.now() / 1000),
    adapter = adapterFor(chainId);
  const intent: EvmTransferIntent = {
    family: "evm",
    action: "EVM_NATIVE_TRANSFER",
    version: 1,
    chainId,
    recipient,
    relayer,
    amount: "1000000000000",
    asset: { kind: "native" },
    feeCapWei: n.gasBudget.toString(),
    quotation: {
      block: "0",
      calldataHash: keccak256("0x"),
      gas: "1",
      feeCapWei: "0",
      at: now,
      expires: now + 90,
    },
    zatoshis: "100000",
    nonce: nonce(),
    expiry: now + 7200,
    pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE",
    profileId: randomUUID(),
    requestId: randomUUID(),
  };
  try {
    await adapter.health();
    const code = await adapter.client.getBytecode({ address: recipient });
    if (code && code !== "0x") throw Error("EOA_RECIPIENT_REQUIRED");
    const q = await quoteTransfer(adapter, intent, relayer);
    const [pending, confirmed] = await Promise.all([
      adapter.client.getTransactionCount({
        address: relayer,
        blockTag: "pending",
      }),
      adapter.client.getTransactionCount({
        address: relayer,
        blockTag: "latest",
      }),
    ]);
    results.push({
      chainId,
      network: n.name,
      simulation: "PASSED",
      amountWei: q.amount,
      gas: q.gas,
      feeCapWei: q.feeCapWei,
      maxFeePerGas: q.maxFeePerGas,
      relayerLiquiditySufficient: true,
      relayerHasPendingTransactions: pending !== confirmed,
      confidence: "PRIMARY_ONLY",
      recipientEOA: true,
      signing: false,
      broadcast: false,
    });
  } catch (e) {
    const message = (e as Error).message;
    results.push({
      chainId,
      network: n.name,
      simulation: "BLOCKED",
      reason: [
        "gas_budget_exceeded",
        "INSUFFICIENT_RELAYER_LIQUIDITY",
        "EOA_RECIPIENT_REQUIRED",
        "rpc_chain_mismatch",
      ].includes(message)
        ? message
        : "PUBLIC_READ_OR_SIMULATION_FAILED",
      confidence: "PRIMARY_ONLY",
      signing: false,
      broadcast: false,
    });
  }
}
mkdirSync("docs/end-to-end-evidence", { recursive: true });
const report = {
  legacyReservationsPresent: providerReserved(),
  at: new Date().toISOString(),
  sourcePaymentQueried: false,
  financialOrderCreated: false,
  newPayment: false,
  liveKeyAccess: false,
  results,
};
writeFileSync(
  "docs/end-to-end-evidence/live-readiness.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
