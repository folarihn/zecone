// Independent read-only chain + wallet evidence. No transaction is signed or broadcast.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashTypedData, ContractFunctionRevertedError } from "viem";
import { readJson, exclusiveJson } from "../services/execution/io.ts";
import { SwapBase, inspect } from "../services/swaps/adapter.ts";
import {
  tokenAbi,
  executorAbi,
  swapTyped,
  swapParams,
  type SwapConfig,
  type SwapIntent,
} from "../services/swaps/intent.ts";
import type { Order } from "../services/execution/store.ts";
const mode = process.argv[2] ?? "verify";
if (!["verify", "before-restart", "after-restart"].includes(mode))
  throw Error("Invalid verification mode");
const c = readJson<SwapConfig>(".state/swap-84532-confirmed.json"),
  b = new SwapBase(c),
  quote = readJson<any>(".state/phase4b-live.quote.json"),
  start = readJson<any>(".state/phase4b-live.started.json"),
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
  const i = JSON.parse(o.intent) as SwapIntent;
  assert.equal(hashTypedData(swapTyped(i)), o.id);
  assert.equal(i.recipient, c.user);
  assert.notEqual(c.user, c.provider);
  assert.equal(i.kind, "swap");
  assert.equal(i.maxNative, "100000000000000");
  assert.equal(i.zatoshis, "1000000");
  assert.equal(i.slippageBps, 100);
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
  checkpoint = "destination receipt";
  const verified = await b.receipt(o);
  assert.equal(verified.status, "success");
  if (verified.status !== "success") throw Error("receipt pending");
  const receipt = await b.public.getTransactionReceipt({ hash: o.tx_hash }),
    state = await inspect(c, b.public, receipt.blockNumber),
    before = await inspect(c, b.public, receipt.blockNumber - 1n);
  assert.equal(state.reserveIn - before.reserveIn, BigInt(i.maxNative));
  assert.equal(
    before.reserveOut - state.reserveOut,
    BigInt(verified.amountOut!),
  );
  const token = await b.public.readContract({
      address: c.token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [c.user],
    }),
    user = await b.public.getBalance({ address: c.user }),
    provider = await b.public.getBalance({ address: c.provider }),
    nonce = await b.public.getTransactionCount({ address: c.provider });
  assert.equal(
    token - BigInt(start.balancesBefore.token),
    BigInt(verified.amountOut!),
  );
  assert.equal(user.toString(), start.balancesBefore.user);
  const providerSpent = BigInt(start.balancesBefore.provider) - provider,
    actualFee = providerSpent - BigInt(i.maxNative);
  assert.ok(actualFee >= receipt.gasUsed * receipt.effectiveGasPrice);
  assert.ok(actualFee <= BigInt(i.maxGas));
  const counts = db
    .prepare(
      "SELECT sum(event='broadcast_attempt') broadcasts,sum(event='scan_verified') scans FROM audit WHERE order_id=?",
    )
    .get(o.id) as any;
  assert.equal(counts.broadcasts, 1);
  checkpoint = "replay simulation";
  await assert.rejects(
    b.public.simulateContract({
      // Replay at the settlement block stays reproducible after quote expiry.
      blockNumber: receipt.blockNumber,
      account: c.provider,
      address: c.executor,
      abi: executorAbi,
      functionName: "execute",
      args: [swapTyped(i).message, swapParams(i), i.signature],
      value: BigInt(i.maxNative),
    }),
    (e: any) =>
      e.walk?.((x: any) => x instanceof ContractFunctionRevertedError)?.data
        ?.errorName === "Replay",
  );
  const snapshot = {
    order: o.id,
    transaction: o.tx_hash,
    payment: r.payment_tx,
    state: o.state,
    provider: provider.toString(),
    user: user.toString(),
    token: token.toString(),
    nonce,
    ...counts,
  };
  const root = "docs/phase4b-evidence/base";
  mkdirSync(root, { recursive: true });
  if (mode === "before-restart")
    exclusiveJson(".state/phase4b-restart.json", snapshot);
  if (mode === "after-restart") {
    checkpoint = "restart";
    const old = readJson<any>(".state/phase4b-restart.json");
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
  const evidence = {
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
    swap: {
      ...verified,
      router: c.router,
      pool: c.pool,
      expectedOut: i.expectedOut,
      minOut: i.minOut,
      slippageBps: i.slippageBps,
      amountIn: i.maxNative,
      blockHash: receipt.blockHash,
      confirmations: String(
        (await b.public.getBlockNumber()) - receipt.blockNumber + 1n,
      ),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      actualTotalFeeWei: actualFee.toString(),
      executionFeeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      additionalFeeWei: (
        actualFee -
        receipt.gasUsed * receipt.effectiveGasPrice
      ).toString(),
    },
    reserves: {
      before: {
        native: before.reserveIn.toString(),
        token: before.reserveOut.toString(),
      },
      after: {
        native: state.reserveIn.toString(),
        token: state.reserveOut.toString(),
      },
    },
    balances: {
      before: start.balancesBefore,
      after: {
        provider: provider.toString(),
        user: user.toString(),
        token: token.toString(),
      },
      providerSpent: providerSpent.toString(),
    },
    replay: {
      simulationRejected: true,
      simulationBlock: receipt.blockNumber.toString(),
      duplicateTransactionSent: false,
    },
    limitations:
      "Trusted provider and scanner; simulated ZEC rate, real test AMM; manual recovery; Base L2 confirmations are not parent finality.",
  };
  writeFileSync(
    `${root}/live-verification.json`,
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({
      verified: true,
      mode,
      payment: r.payment_tx,
      swap: o.tx_hash,
      tokenReceived: verified.amountOut,
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
