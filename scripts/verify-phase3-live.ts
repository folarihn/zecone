// Independently verify canonical live evidence. Read only on both networks.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, readdirSync } from "node:fs";
import {
  ContractFunctionRevertedError,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  PurchaseBase,
  marketAbi,
  nftAbi,
  executorAbi,
  purchaseTyped,
  type MarketConfig,
  type PurchaseIntent,
} from "../services/marketplace/purchase.ts";
import { readJson } from "../services/execution/io.ts";
import type { Order } from "../services/execution/store.ts";
const c = readJson<
    MarketConfig & { seller: Address; provider: Address; user: Address }
  >(".state/marketplace-confirmed.json"),
  b = new PurchaseBase(c),
  db = new DatabaseSync(".state/purchases.sqlite", { readOnly: true });
let checkpoint = "saved-order";
try {
  const marker = readJson<{
      purchaseId: string;
      balancesBefore: { provider: string; seller: string; user: string };
    }>(".state/phase3-live-started.json"),
    row = db
      .prepare(
        "SELECT id,stage,payment_tx,order_id FROM purchase_requests WHERE id=?",
      )
      .get(marker.purchaseId) as any;
  assert.ok(row);
  assert.equal(row.stage, "sent");
  const order = db
    .prepare("SELECT * FROM orders WHERE id=?")
    .get(row.order_id) as Order;
  assert.ok(order);
  assert.equal(order.state, "settled");
  assert.ok(order.tx_hash);
  const i = JSON.parse(order.intent) as PurchaseIntent;
  assert.equal(i.kind, "purchase");
  assert.equal(i.recipient, c.user);
  assert.equal(i.listingId, "1");
  assert.equal(i.zatoshis, "1000000");
  assert.equal(i.price, "100000000000000");
  checkpoint = "payment-observation";
  const p = db
    .prepare(
      "SELECT key,zatoshis,height,block_hash,active,confirmed FROM payments WHERE order_id=? AND key LIKE ?",
    )
    .get(order.id, `${row.payment_tx}:%`) as any;
  assert.ok(p);
  assert.equal(p.active, 1);
  assert.equal(p.confirmed, 1);
  assert.equal(p.zatoshis, i.zatoshis);
  const scan = JSON.parse(
    (
      db
        .prepare(
          "SELECT detail FROM audit WHERE order_id=? AND event='scan_verified' ORDER BY seq DESC LIMIT 1",
        )
        .get(order.id) as any
    ).detail,
  );
  assert.equal(scan.tip, scan.scanned);
  assert.ok(scan.tip - p.height + 1 >= 10);
  const prepared = db
    .prepare(
      "SELECT seq,at FROM audit WHERE order_id=? AND event='verified->prepared' ORDER BY seq LIMIT 1",
    )
    .get(order.id) as any;
  assert.ok(prepared);
  const authorizationScan = JSON.parse(
    (
      db
        .prepare(
          "SELECT detail FROM audit WHERE order_id=? AND event='scan_verified' AND seq<? ORDER BY seq DESC LIMIT 1",
        )
        .get(order.id, prepared.seq) as any
    ).detail,
  );
  assert.equal(authorizationScan.tip, authorizationScan.scanned);
  assert.ok(authorizationScan.tip - p.height + 1 >= 10);
  assert.ok(BigInt(authorizationScan.confirmedZatoshis) >= BigInt(i.zatoshis));
  checkpoint = "native-fee";
  const nativeDb = new DatabaseSync(".secrets/user/zcash/wallet.sqlite", {
    readOnly: true,
  });
  let nativePayment: any;
  try {
    nativePayment = nativeDb
      .prepare(
        "SELECT mined_height,account_balance_delta,fee_paid FROM v_transactions WHERE txid=?",
      )
      .get(Buffer.from(row.payment_tx, "hex").reverse());
  } finally {
    nativeDb.close();
  }
  assert.ok(nativePayment);
  assert.equal(nativePayment.mined_height, p.height);
  assert.equal(
    BigInt(nativePayment.account_balance_delta),
    -BigInt(i.zatoshis) - BigInt(nativePayment.fee_paid),
  );
  checkpoint = "canonical-receipt";
  assert.equal((await b.receipt(order)).status, "success");
  const receipt = await b.public.getTransactionReceipt({ hash: order.tx_hash }),
    head = await b.public.getBlockNumber();
  const purchased = receipt.logs
    .filter(
      (l) =>
        getAddress(l.address) === getAddress(c.marketplace) &&
        l.topics[0] ===
          keccak256(
            toHex(
              "Purchased(uint256,address,address,address,uint256,address,uint256)",
            ),
          ),
    )
    .map(
      (l) =>
        decodeEventLog({
          abi: marketAbi,
          eventName: "Purchased",
          data: l.data,
          topics: l.topics,
        }).args,
    );
  assert.equal(purchased.length, 1);
  const transfers = receipt.logs
    .filter(
      (l) =>
        getAddress(l.address) === getAddress(c.nft) &&
        l.topics[0] === keccak256(toHex("Transfer(address,address,uint256)")),
    )
    .map(
      (l) =>
        decodeEventLog({
          abi: nftAbi,
          eventName: "Transfer",
          data: l.data,
          topics: l.topics,
        }).args,
    );
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].from, c.seller);
  assert.equal(transfers[0].to, c.user);
  assert.equal(transfers[0].tokenId, 1n);
  const owner = await b.public.readContract({
    address: c.nft,
    abi: nftAbi,
    functionName: "ownerOf",
    args: [1n],
  });
  assert.equal(owner, c.user);
  assert.notEqual(c.user, c.provider);
  assert.notEqual(c.user, c.seller);
  const attempts = (
    db
      .prepare(
        "SELECT count(*) n FROM audit WHERE order_id=? AND event='broadcast_attempt'",
      )
      .get(order.id) as any
  ).n;
  assert.equal(attempts, 1);
  checkpoint = "replay-revert";
  // A replay is simulated only; do not pay gas for a known reverting duplicate.
  await assert.rejects(
    b.public.simulateContract({
      account: b.account.address,
      address: c.executor,
      abi: executorAbi,
      functionName: "execute",
      args: [purchaseTyped(i).message, i.signature],
      value: BigInt(i.price),
    }),
    (e: any) => {
      const revert = e.walk?.(
        (x: any) => x instanceof ContractFunctionRevertedError,
      );
      return revert?.data?.errorName === "Replay";
    },
  );
  checkpoint = "transaction-accounting";
  const tx = await b.public.getTransaction({ hash: order.tx_hash });
  assert.equal(getAddress(tx.from), getAddress(c.provider));
  assert.equal(getAddress(tx.to!), getAddress(c.executor));
  assert.equal(tx.value, BigInt(i.price));
  const [providerAfter, sellerAfter, userAfter] = await Promise.all([
    b.public.getBalance({ address: c.provider }),
    b.public.getBalance({ address: c.seller }),
    b.public.getBalance({ address: c.user }),
  ]);
  assert.equal(
    sellerAfter - BigInt(marker.balancesBefore.seller),
    BigInt(i.price),
  );
  assert.equal(userAfter, BigInt(marker.balancesBefore.user));
  const spent = BigInt(marker.balancesBefore.provider) - providerAfter;
  assert.ok(spent >= BigInt(i.price));
  assert.ok(spent <= BigInt(i.price) + BigInt(i.gasBudget));
  const setup = await Promise.all(
    readdirSync(".state/phase3-setup")
      .filter((f) => f.endsWith(".confirmed.json"))
      .map(async (f) => {
        const saved = readJson<any>(`.state/phase3-setup/${f}`),
          receipt = await b.public.getTransactionReceipt({ hash: saved.hash });
        assert.equal(receipt.status, "success");
        assert.equal(receipt.blockNumber.toString(), saved.block);
        assert.equal(
          (await b.public.getBlock({ blockNumber: receipt.blockNumber })).hash,
          receipt.blockHash,
        );
        assert.ok(head - receipt.blockNumber + 1n >= 3n);
        return {
          step: f.replace(".confirmed.json", ""),
          ...saved,
          blockHash: receipt.blockHash,
          canonicalRechecked: true,
          initialReceiptHadPlaceholder:
            saved.blockHash === `0x${"0".repeat(64)}`,
        };
      }),
  );
  const evidence = {
    verifiedAt: new Date().toISOString(),
    live: true,
    networks: { zcash: "testnet", base: 84532 },
    purchaseId: row.id,
    orderId: order.id,
    contracts: c,
    zcash: {
      txid: row.payment_tx,
      zatoshis: p.zatoshis,
      pool: Number(p.key.split(":")[1]),
      outputIndex: Number(p.key.split(":")[2]),
      blockHeight: p.height,
      blockHash: p.block_hash,
      scannedTip: scan.tip,
      confirmations: scan.tip - p.height + 1,
      requiredConfirmations: 10,
      confirmationsAtAuthorization: authorizationScan.tip - p.height + 1,
      authorizedAt: prepared.at,
      nativeFeeZatoshis: String(nativePayment.fee_paid),
      totalUserDebitZatoshis: String(-nativePayment.account_balance_delta),
    },
    base: {
      hash: order.tx_hash,
      block: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      confirmations: (head - receipt.blockNumber + 1n).toString(),
      status: receipt.status,
      owner,
      tokenId: "1",
      marketplaceEvent: purchased[0],
      transfer: transfers[0],
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    },
    liquidity: {
      before: marker.balancesBefore,
      after: {
        provider: providerAfter.toString(),
        seller: sellerAfter.toString(),
        user: userAfter.toString(),
      },
      sellerReceivedWei: (
        sellerAfter - BigInt(marker.balancesBefore.seller)
      ).toString(),
      providerSpentWei: spent.toString(),
      actualTotalFeeWei: (spent - BigInt(i.price)).toString(),
      quotedGasReserveWei: i.gasBudget,
      simulatedRateWeiPerZec: i.rate,
      refundSent: false,
    },
    replay: { broadcastAttempts: attempts, repeatCallRejected: true },
    setup,
    trust:
      "Trusted prefunded provider; simulated rate; public NFT purchase and ownership; provider can correlate payment. No production exchange or trustless bridge.",
  };
  writeFileSync(
    "docs/phase3-evidence/live-verification.json",
    JSON.stringify(
      evidence,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
  console.log(
    JSON.stringify({
      verified: true,
      zcash: row.payment_tx,
      base: order.tx_hash,
      owner,
      tokenId: "1",
      broadcastAttempts: attempts,
    }),
  );
} catch {
  console.error(`Verification stopped at: ${checkpoint}`);
  console.error(
    "Phase 3 live verification did not pass. Do not claim success; inspect canonical receipts and saved payment evidence.",
  );
  process.exitCode = 1;
} finally {
  db.close();
}
