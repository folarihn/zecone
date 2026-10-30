// Independent read-only proof. Never signs, retries payment or broadcasts.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashTypedData, ContractFunctionRevertedError } from "viem";
import { readJson, exclusiveJson } from "../services/execution/io.ts";
import { SeaportBase } from "../services/seaport/adapter.ts";
import {
  PROTOCOL,
  seaportAbi,
  executorAbi,
  components,
  advanced,
  orderHash,
  typed,
  eq,
  type SeaportConfig,
  type SeaportIntent,
} from "../services/seaport/protocol.ts";
import { nftAbi } from "../services/marketplace/purchase.ts";
import type { Order } from "../services/execution/store.ts";
const mode = process.argv[2] ?? "verify";
if (!["verify", "before-restart", "after-restart"].includes(mode))
  throw Error("Invalid verification mode");
const c = readJson<SeaportConfig>(".state/seaport-84532-confirmed.json"),
  b = new SeaportBase(c),
  quote = readJson<any>(".state/phase4c-live.quote.json"),
  start = readJson<any>(".state/phase4c-live.started.json"),
  db = new DatabaseSync(".state/purchases.sqlite", { readOnly: true });
db.exec("PRAGMA busy_timeout=5000");
let checkpoint = "journal";
try {
  const r = db
    .prepare("SELECT * FROM purchase_requests WHERE id=?")
    .get(quote.id) as any;
  assert.ok(r);
  assert.equal(r.stage, "sent");
  const o = db
    .prepare("SELECT * FROM orders WHERE id=?")
    .get(r.order_id) as Order;
  assert.equal(o.state, "settled");
  assert.ok(o.tx_hash);
  const i = JSON.parse(o.intent) as SeaportIntent;
  assert.equal(i.kind, "seaport");
  assert.equal(hashTypedData(typed(i)), o.id);
  assert.equal(i.listing.orderHash, orderHash(i.listing));
  assert.ok(eq(i.recipient, c.user));
  assert.ok(!eq(c.user, c.provider));
  assert.equal(i.price, "102500000000000");
  assert.equal(i.zatoshis, "1012500");
  assert.equal(i.feeAmount, "2500000000000");
  assert.ok(eq(c.feeRecipient, c.provider));
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
  checkpoint = "Zcash payment";
  const note = db
    .prepare("SELECT * FROM payments WHERE order_id=? AND key LIKE ?")
    .get(o.id, `${r.payment_tx}:%`) as any;
  assert.ok(note);
  assert.equal(note.active, 1);
  assert.equal(note.confirmed, 1);
  assert.equal(note.zatoshis, i.zatoshis);
  const prepared = db
    .prepare(
      "SELECT seq,at FROM audit WHERE order_id=? AND event='verified->prepared' ORDER BY seq LIMIT 1",
    )
    .get(o.id) as any;
  assert.ok(prepared);
  const auth = JSON.parse(
    (
      db
        .prepare(
          "SELECT detail FROM audit WHERE order_id=? AND event='scan_verified' AND seq<? ORDER BY seq DESC LIMIT 1",
        )
        .get(o.id, prepared.seq) as any
    ).detail,
  );
  assert.equal(auth.scanned, auth.tip);
  assert.ok(auth.tip - note.height + 1 >= 10);
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
      .get(Buffer.from(r.payment_tx, "hex").reverse());
  } finally {
    native.close();
  }
  assert.equal(payment.mined_height, note.height);
  assert.equal(
    BigInt(-payment.account_balance_delta),
    BigInt(i.zatoshis) + BigInt(payment.fee_paid),
  );
  checkpoint = "Seaport receipt";
  const verified = await b.receipt(o);
  assert.equal(verified.status, "success");
  if (verified.status !== "success") throw Error("pending receipt");
  const receipt = await b.public.getTransactionReceipt({ hash: o.tx_hash });
  assert.equal(
    await b.public.readContract({
      address: PROTOCOL,
      abi: seaportAbi,
      functionName: "getOrderHash",
      args: [components(i.listing.parameters)],
      blockNumber: receipt.blockNumber,
    }),
    i.listing.orderHash,
  );
  const owner = await b.public.readContract({
      address: c.nft,
      abi: nftAbi,
      functionName: "ownerOf",
      args: [BigInt(i.tokenId)],
    }),
    seller = await b.public.getBalance({ address: c.seller }),
    provider = await b.public.getBalance({ address: c.provider }),
    user = await b.public.getBalance({ address: c.user }),
    nonce = await b.public.getTransactionCount({ address: c.provider });
  assert.ok(eq(owner, c.user));
  assert.ok(eq(start.balancesBefore.owner, c.seller));
  assert.equal(
    seller - BigInt(start.balancesBefore.seller),
    BigInt(i.listing.parameters.consideration[0].startAmount),
  );
  assert.equal(user.toString(), start.balancesBefore.user);
  const providerNetDebit = BigInt(start.balancesBefore.provider) - provider,
    feeReturnedToProvider = BigInt(i.feeAmount),
    actualFee = providerNetDebit - (BigInt(i.price) - feeReturnedToProvider);
  assert.ok(actualFee >= receipt.gasUsed * receipt.effectiveGasPrice);
  assert.ok(actualFee <= BigInt(i.gasBudget));
  const counts = db
    .prepare(
      "SELECT sum(event='broadcast_attempt') broadcasts,sum(event='scan_verified') scans FROM audit WHERE order_id=?",
    )
    .get(o.id) as any;
  assert.equal(counts.broadcasts, 1);
  checkpoint = "replay simulation";
  await assert.rejects(
    b.public.simulateContract({
      blockNumber: receipt.blockNumber,
      account: c.provider,
      address: c.executor,
      abi: executorAbi,
      functionName: "execute",
      args: [
        typed(i).message,
        advanced(i.listing),
        BigInt(i.listing.parameters.counter),
        i.signature,
      ],
      value: BigInt(i.price),
    }),
    (e: any) =>
      e.walk?.((x: any) => x instanceof ContractFunctionRevertedError)?.data
        ?.errorName === "Replay",
  );
  const snapshot = {
    order: o.id,
    transaction: o.tx_hash,
    seaportOrderHash: i.listing.orderHash,
    payment: r.payment_tx,
    state: o.state,
    provider: provider.toString(),
    seller: seller.toString(),
    user: user.toString(),
    owner,
    nonce,
    ...counts,
  };
  const root = "docs/phase4c-evidence/base";
  mkdirSync(root, { recursive: true });
  if (mode === "before-restart")
    exclusiveJson(".state/phase4c-restart.json", snapshot);
  if (mode === "after-restart") {
    checkpoint = "restart";
    const old = readJson<any>(".state/phase4c-restart.json");
    for (const key of Object.keys(snapshot).filter((k) => k !== "scans"))
      assert.equal((snapshot as any)[key], old[key]);
    assert.ok(snapshot.scans > old.scans);
    writeFileSync(
      `${root}/restart-verification.json`,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          verified: true,
          before: old,
          after: snapshot,
        },
        null,
        2,
      ),
    );
  }
  writeFileSync(
    `${root}/live-verification.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        live: true,
        verified: true,
        chainId: 84532,
        config: c,
        ...snapshot,
        zcash: {
          txid: r.payment_tx,
          pool: Number(note.key.split(":")[1]),
          height: note.height,
          blockHash: note.block_hash,
          zatoshis: i.zatoshis,
          confirmationsAtAuthorization: auth.tip - note.height + 1,
          nativeFeeZatoshis: String(payment.fee_paid),
          totalUserDebitZatoshis: String(-payment.account_balance_delta),
        },
        fulfillment: {
          ...verified,
          source: i.listing.source,
          protocol: PROTOCOL,
          version: "1.6",
          orderHash: i.listing.orderHash,
          nft: c.nft,
          tokenId: i.tokenId,
          seller: c.seller,
          sellerReceived: i.listing.parameters.consideration[0].startAmount,
          feeRecipient: c.feeRecipient,
          feeAmount: i.feeAmount,
          totalConsideration: i.price,
          blockHash: receipt.blockHash,
          confirmations: String(
            (await b.public.getBlockNumber()) - receipt.blockNumber + 1n,
          ),
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice.toString(),
          actualTotalFeeWei: actualFee.toString(),
          executionFeeWei: (
            receipt.gasUsed * receipt.effectiveGasPrice
          ).toString(),
          additionalFeeWei: (
            actualFee -
            receipt.gasUsed * receipt.effectiveGasPrice
          ).toString(),
        },
        balances: {
          before: start.balancesBefore,
          after: {
            provider: provider.toString(),
            seller: seller.toString(),
            user: user.toString(),
            owner,
          },
          providerNetDebit: providerNetDebit.toString(),
          feeReturnedToProvider: feeReturnedToProvider.toString(),
          grossInputPlusGas: (BigInt(i.price) + actualFee).toString(),
        },
        replay: {
          simulationRejected: true,
          simulationBlock: receipt.blockNumber.toString(),
          duplicateTransactionSent: false,
        },
        limitations:
          "Controlled Seaport test listing, not an OpenSea API listing. Trusted provider/scanner/RPC; simulated ZEC price; manual recovery; Base confirmations are L2 depth, not parent finality.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      verified: true,
      mode,
      payment: r.payment_tx,
      fulfillment: o.tx_hash,
      orderHash: i.listing.orderHash,
      owner,
      sellerReceived: i.listing.parameters.consideration[0].startAmount,
      actualFeeWei: actualFee.toString(),
    }),
  );
} catch (e) {
  console.error(
    `Verification stopped at ${checkpoint} (${e instanceof Error ? e.name : "error"}). No success assumed.`,
  );
  process.exitCode = 1;
} finally {
  db.close();
}
