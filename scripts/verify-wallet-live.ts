// Independent read-only verification of the existing Phase 1 live checkout.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import {
  createPublicClient,
  getAddress,
  http,
  decodeEventLog,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { abi } from "../services/execution/base.ts";
const app = new DatabaseSync(".state/wallet-app.sqlite", { readOnly: true }),
  store = new DatabaseSync(".state/orders.sqlite", { readOnly: true });
try {
  const c = app
    .prepare(
      "SELECT id,order_id,txid FROM checkouts ORDER BY created DESC LIMIT 1",
    )
    .get() as { id: string; order_id: Hex; txid: string };
  const o = store
    .prepare("SELECT state,tx_hash,intent FROM orders WHERE id=?")
    .get(c.order_id) as { state: string; tx_hash: Hex; intent: string };
  assert.equal(o.state, "settled");
  const intent = JSON.parse(o.intent) as {
    recipient: Address;
    contract: Address;
  };
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });
  assert.equal(await client.getChainId(), 84532);
  const receipt = await client.getTransactionReceipt({ hash: o.tx_hash }),
    head = await client.getBlockNumber();
  assert.equal(receipt.status, "success");
  assert.ok(head - receipt.blockNumber + 1n >= 3n);
  assert.equal(
    (await client.getBlock({ blockNumber: receipt.blockNumber })).hash,
    receipt.blockHash,
  );
  const owner = await client.readContract({
    address: intent.contract,
    abi,
    functionName: "ownerOf",
    args: [BigInt(c.order_id)],
  });
  assert.equal(getAddress(owner), getAddress(intent.recipient));
  assert.equal(
    await client.readContract({
      address: intent.contract,
      abi,
      functionName: "consumed",
      args: [c.order_id],
    }),
    true,
  );
  const events = receipt.logs
    .filter((l) => getAddress(l.address) === getAddress(intent.contract))
    .flatMap((l) => {
      try {
        return [
          decodeEventLog({
            abi,
            eventName: "OrderMinted",
            data: l.data,
            topics: l.topics,
          }).args,
        ];
      } catch {
        return [];
      }
    });
  assert.equal(events.length, 1);
  assert.equal(events[0].orderId, c.order_id);
  assert.equal(getAddress(events[0].recipient), getAddress(owner));
  const payments = store
    .prepare(
      "SELECT key,zatoshis,height,block_hash,active,confirmed FROM payments WHERE order_id=?",
    )
    .all(c.order_id);
  const scans = store
    .prepare(
      "SELECT at,detail FROM audit WHERE order_id=? AND event='scan_verified' ORDER BY seq",
    )
    .all(c.order_id) as { at: number; detail: string }[];
  const authorized = scans
    .map((s) => ({ ...JSON.parse(s.detail), at: s.at }))
    .find((s) => BigInt(s.confirmedZatoshis) >= 1000000n);
  assert.ok(authorized);
  assert.equal(authorized.requiredConfirmations, 10);
  assert.equal(
    store
      .prepare(
        "SELECT count(*) AS n FROM audit WHERE order_id=? AND event='created'",
      )
      .get(c.order_id)?.n,
    1,
  );
  const counts = {
    orders: store
      .prepare("SELECT count(*) AS n FROM orders WHERE id=?")
      .get(c.order_id)?.n,
    payments: payments.length,
    mintEvents: events.length,
    broadcastAttempts: store
      .prepare(
        "SELECT count(*) AS n FROM audit WHERE order_id=? AND event='broadcast_attempt'",
      )
      .get(c.order_id)?.n,
  };
  const evidence = {
    verifiedAt: new Date().toISOString(),
    checkoutId: c.id,
    orderId: c.order_id,
    zcashTransaction: c.txid,
    payments,
    authorization: authorized,
    base: {
      chainId: 84532,
      contract: intent.contract,
      transaction: receipt.transactionHash,
      block: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      confirmations: (head - receipt.blockNumber + 1n).toString(),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      owner,
      tokenId: BigInt(c.order_id).toString(),
      consumed: true,
    },
    counts,
  };
  writeFileSync(
    "docs/phase1-evidence/live-verification.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  app.close();
  store.close();
}
