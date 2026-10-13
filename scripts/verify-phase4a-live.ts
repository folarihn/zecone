// Independent, read-only proof. Simulation of replay is labeled and never broadcast.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import {
  ContractFunctionRevertedError,
  decodeEventLog,
  getAddress,
  keccak256,
  toHex,
  type Address,
} from "viem";
import { network } from "../services/evm/networks.ts";
import { readJson, exclusiveJson } from "../services/execution/io.ts";
import {
  PurchaseBase,
  marketAbi,
  nftAbi,
  multichainExecutorAbi,
  executorAbi,
  purchaseTyped,
  priceZatoshis,
  type MarketConfig,
  type PurchaseIntent,
} from "../services/marketplace/purchase.ts";
import type { Order } from "../services/execution/store.ts";
const chainId = Number(process.argv[2]),
  n = network(chainId),
  mode = process.argv[3] ?? "verify";
if (
  chainId === 84532 ||
  !["verify", "before-restart", "after-restart"].includes(mode)
)
  throw Error("New testnet and supported mode required");
const c = readJson<
    MarketConfig & { seller: Address; provider: Address; user: Address }
  >(n.deploymentFile),
  b = new PurchaseBase(c);
const marker = readJson<{
  purchaseId: string;
  balancesBefore: { provider: string; seller: string; user: string };
}>(`.state/phase4a-live-${chainId}.json`);
const db = new DatabaseSync(".state/purchases.sqlite", { readOnly: true });
let checkpoint = "order";
try {
  const row = db
    .prepare(
      "SELECT id,stage,order_id,payment_tx FROM purchase_requests WHERE id=?",
    )
    .get(marker.purchaseId) as any;
  assert.ok(row);
  assert.equal(row.stage, "sent");
  const o = db
    .prepare("SELECT * FROM orders WHERE id=?")
    .get(row.order_id) as Order;
  assert.equal(o.state, "settled");
  assert.ok(o.tx_hash);
  const i = JSON.parse(o.intent) as PurchaseIntent;
  assert.equal(i.chainId, chainId);
  assert.equal(i.recipient, c.user);
  assert.equal(i.listingId, "1");
  assert.equal(i.price, "100000000000000");
  assert.equal(i.zatoshis, priceZatoshis(BigInt(i.price), chainId).toString());
  assert.notEqual(c.user, c.provider);
  assert.notEqual(c.user, c.seller);
  assert.equal(
    (
      db
        .prepare(
          "SELECT count(*) n FROM recoveries WHERE order_id=? AND status='review_required'",
        )
        .get(o.id) as any
    ).n,
    0,
  );
  checkpoint = "payment";
  const p = db
    .prepare(
      "SELECT key,zatoshis,height,block_hash,active,confirmed FROM payments WHERE order_id=? AND key LIKE ?",
    )
    .get(o.id, `${row.payment_tx}:%`) as any;
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
        .get(o.id) as any
    ).detail,
  );
  const prepared = db
    .prepare(
      "SELECT seq,at FROM audit WHERE order_id=? AND event='verified->prepared' ORDER BY seq LIMIT 1",
    )
    .get(o.id) as any;
  const auth = JSON.parse(
    (
      db
        .prepare(
          "SELECT detail FROM audit WHERE order_id=? AND event='scan_verified' AND seq<? ORDER BY seq DESC LIMIT 1",
        )
        .get(o.id, prepared.seq) as any
    ).detail,
  );
  assert.equal(scan.tip, scan.scanned);
  assert.equal(auth.tip, auth.scanned);
  assert.ok(auth.tip - p.height + 1 >= 10);
  assert.ok(BigInt(auth.confirmedZatoshis) >= BigInt(i.zatoshis));
  const native = new DatabaseSync(".secrets/user/zcash/wallet.sqlite", {
    readOnly: true,
  });
  let payment: any;
  try {
    payment = native
      .prepare(
        "SELECT mined_height,account_balance_delta,fee_paid FROM v_transactions WHERE txid=?",
      )
      .get(Buffer.from(row.payment_tx, "hex").reverse());
  } finally {
    native.close();
  }
  assert.ok(payment);
  assert.equal(payment.mined_height, p.height);
  assert.equal(
    BigInt(payment.account_balance_delta),
    -BigInt(i.zatoshis) - BigInt(payment.fee_paid),
  );
  checkpoint = "destination";
  assert.equal((await b.receipt(o)).status, "success");
  const receipt = await b.public.getTransactionReceipt({ hash: o.tx_hash }),
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
  const owner = await b.public.readContract({
    address: c.nft,
    abi: nftAbi,
    functionName: "ownerOf",
    args: [1n],
  });
  assert.equal(owner, c.user);
  const tx = await b.public.getTransaction({ hash: o.tx_hash });
  assert.ok("chainId" in tx);
  assert.equal(tx.chainId, chainId);
  assert.equal(getAddress(tx.from), c.provider);
  assert.equal(getAddress(tx.to!), getAddress(c.executor));
  assert.equal(tx.value, BigInt(i.price));
  const counts = db
    .prepare(
      "SELECT sum(event='broadcast_attempt') broadcasts,sum(event='scan_verified') scans FROM audit WHERE order_id=?",
    )
    .get(o.id) as any;
  assert.equal(counts.broadcasts, 1);
  const [provider, seller, user, nonce] = await Promise.all([
    b.public.getBalance({ address: c.provider }),
    b.public.getBalance({ address: c.seller }),
    b.public.getBalance({ address: c.user }),
    b.public.getTransactionCount({ address: c.provider }),
  ]);
  assert.equal(seller - BigInt(marker.balancesBefore.seller), BigInt(i.price));
  assert.equal(user, BigInt(marker.balancesBefore.user));
  const spent = BigInt(marker.balancesBefore.provider) - provider,
    fee = spent - BigInt(i.price);
  assert.ok(fee >= 0n && fee <= BigInt(i.gasBudget));
  assert.equal(fee, receipt.gasUsed * receipt.effectiveGasPrice);
  const snapshot = {
    purchaseId: row.id,
    orderId: o.id,
    chainId,
    paymentTx: row.payment_tx,
    destinationTx: o.tx_hash,
    owner,
    state: o.state,
    nonce,
    providerWei: provider.toString(),
    ...counts,
  };
  const root = `docs/phase4a-evidence/${chainId}`;
  mkdirSync(root, { recursive: true });
  if (mode === "before-restart")
    exclusiveJson(`.state/phase4a-restart-${chainId}.json`, snapshot);
  if (mode === "after-restart") {
    const before = readJson<any>(`.state/phase4a-restart-${chainId}.json`);
    for (const k of Object.keys(snapshot).filter((k) => k !== "scans"))
      assert.equal((snapshot as any)[k], before[k]);
    assert.ok(snapshot.scans > before.scans);
    writeFileSync(
      `${root}/restart-verification.json`,
      JSON.stringify(
        {
          verified: true,
          at: new Date().toISOString(),
          before,
          after: snapshot,
        },
        null,
        2,
      ),
    );
  }
  checkpoint = "replay";
  assert.equal(i.sourceNetwork, keccak256(toHex("zcash-testnet")));
  assert.equal(i.provider, c.provider);
  assert.equal(i.adapter, keccak256(toHex(n.adapter)));
  const quote = {
    ...purchaseTyped(i).message,
    sourceNetwork: i.sourceNetwork!,
    provider: i.provider!,
    adapter: i.adapter!,
  };
  await assert.rejects(
    b.public.simulateContract({
      account: b.account.address,
      address: c.executor,
      abi: multichainExecutorAbi,
      functionName: "execute",
      args: [quote, i.signature],
      value: BigInt(i.price),
    }),
    (e: any) =>
      e.walk?.((x: any) => x instanceof ContractFunctionRevertedError)?.data
        ?.errorName === "Replay",
  );
  checkpoint = "cross-chain-replay";
  const otherChain = chainId === 11155111 ? 46630 : 11155111;
  const otherConfig = readJson<MarketConfig>(network(otherChain).deploymentFile);
  const other = new PurchaseBase(otherConfig);
  await other.check();
  await assert.rejects(
    other.public.simulateContract({account:other.account.address,address:otherConfig.executor,abi:multichainExecutorAbi,functionName:"execute",args:[quote,i.signature],value:BigInt(i.price)}),
    (e:any) => e.walk?.((x:any) => x instanceof ContractFunctionRevertedError)?.data?.errorName === "InvalidQuote",
  );
  checkpoint = "setup-receipts";
  const setup = [];
  for (const f of readdirSync(`.state/phase4a-setup/${chainId}`).filter((f) =>
    f.endsWith(".confirmed.json"),
  )) {
    const saved = readJson<any>(`.state/phase4a-setup/${chainId}/${f}`),
      r = await b.public.getTransactionReceipt({ hash: saved.hash });
    assert.equal(r.status, "success");
    assert.equal(r.blockHash, saved.blockHash);
    assert.equal(
      (await b.public.getBlock({ blockNumber: r.blockNumber })).hash,
      r.blockHash,
    );
    assert.ok(head - r.blockNumber + 1n >= BigInt(n.confirmations));
    setup.push({
      step: f.replace(".confirmed.json", ""),
      ...saved,
      actualFeeWei: (r.gasUsed * r.effectiveGasPrice).toString(),
    });
  }
  const evidence = {
    verifiedAt: new Date().toISOString(),
    live: true,
    networks: { zcash: "testnet", destination: chainId },
    contracts: c,
    ...snapshot,
    zcash: {
      txid: row.payment_tx,
      zatoshis: i.zatoshis,
      pool: Number(p.key.split(":")[1]),
      height: p.height,
      blockHash: p.block_hash,
      confirmations: scan.tip - p.height + 1,
      confirmationsAtAuthorization: auth.tip - p.height + 1,
      nativeFeeZatoshis: String(payment.fee_paid),
      totalUserDebitZatoshis: String(-payment.account_balance_delta),
    },
    destination: {
      hash: o.tx_hash,
      block: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      confirmations: (head - receipt.blockNumber + 1n).toString(),
      requiredConfirmations: n.confirmations,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      actualFeeWei: fee.toString(),
      sellerPayment: purchased[0],
      owner,
      tokenId: "1",
    },
    liquidity: {
      before: marker.balancesBefore,
      after: {
        provider: provider.toString(),
        seller: seller.toString(),
        user: user.toString(),
      },
      sellerReceivedWei: (
        seller - BigInt(marker.balancesBefore.seller)
      ).toString(),
      providerSpentWei: spent.toString(),
      quotedGasReserveWei: i.gasBudget,
    },
    replay: {
      broadcasts: counts.broadcasts,
      simulationRejected: true,
      crossChainSimulationRejected: true,
      duplicateTransactionSent: false,
    },
    setup,
    limitations:
      "Trusted provider, simulated rate, manual refunds. Robinhood destination confirmations do not prove parent-chain finality.",
  };
  writeFileSync(
    `${root}/live-verification.json`,
    JSON.stringify(
      evidence,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
  console.log(
    JSON.stringify({
      verified: true,
      mode,
      chainId,
      zcash: row.payment_tx,
      destination: o.tx_hash,
      owner,
      feeWei: fee.toString(),
    }),
  );
} catch (e) {
  console.error(
    `Verification failed at ${checkpoint}: ${e instanceof Error ? e.name : "error"}. No success is assumed.`,
  );
  process.exitCode = 1;
} finally {
  db.close();
}
