// Read-only reconciliation of the real Phase 2 shielded payment and Base action.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decodeEventLog, getAddress, keccak256, toHex } from "viem";
import {
  ActionBase,
  actionAbi,
  type ActionIntent,
} from "../services/execution/action.ts";
import { readJson } from "../services/execution/io.ts";
import type { Order } from "../services/execution/store.ts";

const action = new ActionBase(
  readJson<{ contract: `0x${string}` }>(".state/actions-confirmed.json")
    .contract,
);
const app = new DatabaseSync(".state/wallet-app.sqlite", { readOnly: true });
const store = new DatabaseSync(".state/orders.sqlite", { readOnly: true });
try {
  await action.check();
  const checkout = app
    .prepare(
      "SELECT id,order_id,txid,stage FROM checkouts WHERE order_id IS NOT NULL ORDER BY created DESC LIMIT 1",
    )
    .get() as
    { id: string; order_id: string; txid: string; stage: string } | undefined;
  assert.ok(checkout, "No action checkout found");
  const order = store
    .prepare("SELECT * FROM orders WHERE id=?")
    .get(checkout.order_id) as Order | undefined;
  assert.ok(order, "No settlement order found");
  assert.equal(order.state, "settled");
  assert.ok(order.tx_hash);
  assert.equal(checkout.stage, "sent");
  const intent = JSON.parse(order.intent) as ActionIntent;
  assert.equal(intent.kind, "action");
  assert.equal(intent.chainId, 84532);
  assert.equal(intent.zatoshis, "1000000");
  assert.equal(intent.maxValue, "0");
  assert.equal(intent.target.toLowerCase(), action.contract.toLowerCase());

  const payment = store
    .prepare(
      "SELECT key,zatoshis,height,block_hash,active,confirmed FROM payments WHERE order_id=? AND key LIKE ?",
    )
    .get(order.id, `${checkout.txid}:%`) as
    | {
        key: string;
        zatoshis: string;
        height: number;
        block_hash: string;
        active: number;
        confirmed: number;
      }
    | undefined;
  assert.ok(
    payment,
    "The approved Zcash transaction has no observed shielded output",
  );
  assert.equal(payment.active, 1);
  assert.equal(payment.confirmed, 1);
  assert.equal(payment.zatoshis, "1000000");
  const latestScan = store
    .prepare(
      "SELECT detail FROM audit WHERE order_id=? AND event='scan_verified' ORDER BY seq DESC LIMIT 1",
    )
    .get(order.id) as { detail: string } | undefined;
  assert.ok(latestScan);
  const scan = JSON.parse(latestScan.detail) as {
    tip: number;
    scanned: number;
    requiredConfirmations: number;
    confirmedZatoshis: string;
  };
  const zcashConfirmations = scan.tip - payment.height + 1;
  assert.equal(scan.tip, scan.scanned);
  assert.ok(zcashConfirmations >= 10);
  assert.ok(BigInt(scan.confirmedZatoshis) >= BigInt(intent.zatoshis));

  const [receipt, head, consumed, records, relayer] = await Promise.all([
    action.public.getTransactionReceipt({ hash: order.tx_hash }),
    action.public.getBlockNumber(),
    action.public.readContract({
      address: action.contract,
      abi: actionAbi,
      functionName: "consumed",
      args: [order.id as `0x${string}`],
    }),
    action.public.readContract({
      address: action.contract,
      abi: actionAbi,
      functionName: "records",
      args: [intent.recipient],
    }),
    action.public.readContract({
      address: action.contract,
      abi: actionAbi,
      functionName: "relayer",
    }),
  ]);
  assert.equal(await action.public.getChainId(), 84532);
  assert.equal(receipt.status, "success");
  const canonical = await action.public.getBlock({
    blockNumber: receipt.blockNumber,
  });
  assert.equal(canonical.hash, receipt.blockHash);
  const baseConfirmations = head - receipt.blockNumber + 1n;
  assert.ok(baseConfirmations >= 3n);
  assert.equal(consumed, true);
  assert.equal(records, 1n);
  assert.notEqual(getAddress(intent.recipient), getAddress(relayer));
  const actionTopic = keccak256(
    toHex("ActionExecuted(bytes32,bytes32,address)"),
  );
  const events = receipt.logs
    .filter(
      (log) =>
        getAddress(log.address) === getAddress(action.contract) &&
        log.topics[0] === actionTopic,
    )
    .flatMap((log) => {
      try {
        return [
          decodeEventLog({
            abi: actionAbi,
            eventName: "ActionExecuted",
            data: log.data,
            topics: log.topics,
          }).args,
        ];
      } catch {
        return [];
      }
    });
  assert.equal(events.length, 1);
  assert.equal(events[0].digest, order.id);
  assert.equal(events[0].orderId, intent.orderId);
  assert.equal(getAddress(events[0].recipient), getAddress(intent.recipient));
  const settlementAttempts = store
    .prepare(
      "SELECT count(*) AS n FROM audit WHERE order_id=? AND event='broadcast_attempt'",
    )
    .get(order.id) as { n: number };
  assert.equal(settlementAttempts.n, 1);
  const evidence = {
    verifiedAt: new Date().toISOString(),
    live: true,
    network: { zcash: "testnet", baseChainId: 84532 },
    checkoutId: checkout.id,
    orderId: order.id,
    zcash: {
      txid: checkout.txid,
      valueZatoshis: payment.zatoshis,
      blockHeight: payment.height,
      blockHash: payment.block_hash,
      confirmations: zcashConfirmations,
      requiredConfirmations: 10,
      scannedTip: scan.tip,
      fullyScanned: scan.tip === scan.scanned,
    },
    action: {
      contract: action.contract,
      transaction: receipt.transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      observedHead: head.toString(),
      confirmations: baseConfirmations.toString(),
      recipient: intent.recipient,
      action: "recordFor(userControlledWallet, fixed ZecOne note)",
      records: records.toString(),
      consumed: true,
      exactEvents: events.length,
      settlementBroadcastAttempts: settlementAttempts.n,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    },
  };
  writeFileSync(
    "docs/phase2-evidence/sponsor-final.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  app.close();
  store.close();
}
