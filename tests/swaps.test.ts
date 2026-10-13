// All chain execution here is local Anvil; shielded snapshots are synthetic fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  encodeFunctionData,
  keccak256,
  toHex,
  zeroAddress,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { Base } from "../services/execution/base.ts";
import { exclusiveJson } from "../services/execution/io.ts";
import { infrastructure } from "../services/swaps/setup.ts";
import { SwapBase, quoted, inspect } from "../services/swaps/adapter.ts";
import {
  output,
  impactBps,
  terms,
  signature,
  swapTyped,
  swapParams,
  executorAbi,
  routerAbi,
  tokenAbi,
  ADAPTER,
  SOURCE,
  BUDGET,
  zecCost,
  type UnsignedSwap,
  type SwapIntent,
} from "../services/swaps/intent.ts";
import { SwapJournal, Swaps } from "../services/swaps/service.ts";
import { PurchaseJournal } from "../services/marketplace/journal.ts";
import { Purchases } from "../services/marketplace/service.ts";
import { executeOne } from "../services/execution/worker.ts";

test("concurrent NFT and swap quote reservations cannot double-book one provider balance",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"zecone-reservation-race-")),path=join(dir,"shared.sqlite"),nft=new PurchaseJournal(path),swap=new SwapJournal(path);
 const manifest={base:{user:zeroAddress},zcash:{payer:{account:"synthetic",address:"utest-synthetic"}}};
 const scanner={allocate:async()=>{throw Error("not used");},observe:async()=>{throw Error("not used");}};
 const a=new Purchases(nft,manifest,scanner),b=new Swaps(swap,manifest,scanner);a.lockPath=b.lockPath=join(dir,"provider.lock");
 try{const attempts=await Promise.allSettled([a.withLock(async()=>{await new Promise(r=>setTimeout(r,30));nft.reserve(randomUUID(),"o","s",{kind:"purchase",chainId:84532,price:"60",gasBudget:"10",marketplace:"m",listingId:"1"},"refund",randomUUID(),100n,1);}),b.withLock(async()=>{swap.reserve(randomUUID(),"o","s",{kind:"swap",chainId:84532,price:"60",gasBudget:"10"},"refund",randomUUID(),100n,1);})]);assert.equal(attempts.filter(x=>x.status==="fulfilled").length,1);assert.equal(nft.reserved(),70n);assert.equal(swap.reserved(),70n);}finally{nft.close();swap.close();}
});

test("a confirmed swap cannot allocate a nonce while an NFT transaction is unresolved",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"zecone-nonce-gate-")),store=new SwapJournal(join(dir,"shared.sqlite"));const at=Math.floor(Date.now()/1000),id=toHex(randomBytes(32)),old=toHex(randomBytes(32)),request=randomUUID(),account=randomUUID();
 const intent={kind:"swap",version:1,chainId:84532,price:"1",gasBudget:"1",recipient:zeroAddress,zatoshis:"100",nonce:id,orderId:id,expiry:at+1000,contract:zeroAddress,signature:"0x12"} as any;
 store.reserve(request,"o","s",intent,"refund",randomUUID(),100n,at);store.create(id,intent,account,"utest-synthetic-new",at);store.db.prepare("UPDATE purchase_requests SET order_id=?,stage='sent' WHERE id=?").run(id,request);
 store.create(old,{...intent,kind:"purchase",nonce:old},randomUUID(),"utest-synthetic-old",at);store.db.prepare("UPDATE orders SET state='submitted',tx_hash=? WHERE id=?").run(toHex(randomBytes(32)),old);
 const service=new Swaps(store,{base:{user:zeroAddress},zcash:{payer:{account:"synthetic",address:"utest-synthetic"}}},{allocate:async()=>{throw Error("not used");},observe:async()=>({network:"zcash-testnet",tip:100,scanned:100,observedAt:at,payments:[{account,txid:"ad".repeat(32),pool:4,index:0,zatoshis:"100",height:91,blockHash:"da".repeat(32)}]})});
 service.available=()=>true;service.lockPath=join(dir,"service.lock");service.legacyPath=join(dir,"legacy.sqlite");let prepares=0;service.base=()=>{prepares++;throw Error("must not allocate a provider nonce");};
 try{await service.tick();assert.equal(store.get(id)!.state,"verified");assert.equal(store.get(id)!.tx_hash,null);assert.equal(prepares,0);}finally{store.close();}
});
test("V2 output uses fee-adjusted constant product and worsens with size", () => {
  assert.equal(output(1000n, 100000n, 100000n), 987n);
  assert.equal(impactBps(1000n, 987n, 100000n, 100000n), 130);
  assert.ok(output(2000n, 100000n, 100000n) < 2n * 987n);
  assert.throws(() => output(1n, 0n, 1n));
  assert.equal(zecCost(100000000000000n), 1000000n);
});
test("NFT and swap reservations compete atomically across connections and keep separate views", () => {
  const dir = mkdtempSync(join(tmpdir(), "zecone-shared-")),
    file = join(dir, "ledger.sqlite"),
    nft = new PurchaseJournal(file),
    swap = new SwapJournal(file);
  try {
    nft.reserve(
      randomUUID(),
      "o",
      "s",
      {
        kind: "purchase",
        chainId: 84532,
        price: "60",
        gasBudget: "10",
        marketplace: "m",
        listingId: "1",
      },
      "refund",
      randomUUID(),
      100n,
      1,
    );
    assert.throws(
      () =>
        swap.reserve(
          randomUUID(),
          "o",
          "s",
          { kind: "swap", chainId: 84532, price: "25", gasBudget: "10" },
          "refund",
          randomUUID(),
          100n,
          1,
        ),
      /liquidity/,
    );
    swap.reserve(
      randomUUID(),
      "o",
      "s",
      { kind: "swap", chainId: 84532, price: "20", gasBudget: "10" },
      "refund",
      randomUUID(),
      100n,
      1,
    );
    assert.equal(nft.reserved(), 100n);
    assert.equal(swap.reserved(), 100n);
    assert.equal(nft.rows().length, 1);
    assert.equal(swap.rows().length, 1);
  } finally {
    nft.close();
    swap.close();
  }
});
test("swap APIs reject unconnected and unapproved sessions before touching the signer or native wallet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zecone-swap-auth-")),
    store = new SwapJournal(join(dir, "p.sqlite"));
  const svc = new Swaps(
    store,
    {
      base: { user: zeroAddress },
      zcash: { payer: { account: "test", address: "utest-test" } },
    },
    {
      allocate: async () => {
        throw Error("should not allocate");
      },
      observe: async () => {
        throw Error("should not scan");
      },
    },
  );
  const session = {
    id: "s",
    csrf: "c",
    connected: 0,
    expires: Date.now() + 60000,
  };
  let touches = 0;
  svc.base = () => {
    touches++;
    throw Error("should not touch provider");
  };
  try {
    await assert.rejects(
      svc.quote(session, {
        chainId: 84532,
        amount: "0.0001",
        slippageBps: 100,
        token: zeroAddress,
      }),
    );
    await assert.rejects(svc.fee(session, randomUUID()));
    await assert.rejects(
      svc.pay({ ...session, connected: 1 }, randomUUID(), randomUUID(), false),
    );
    assert.equal(touches, 0);
  } finally {
    store.close();
  }
});
test(
  "local AMM: official V2 artifacts, signed swap, reserve movement, receipt, restart, replay, slippage and failure recovery",
  { timeout: 180000 },
  async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as any).port;
    await new Promise<void>((r) => server.close(() => r()));
    const child = spawn(
      "anvil",
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--chain-id",
        "84532",
        "--base-fee",
        "1000000",
        "--silent",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const dir = mkdtempSync(join(tmpdir(), "zecone-swap-")),
      key = join(dir, "provider.json"),
      db = join(dir, "orders.sqlite");
    exclusiveJson(key, {
      network: "base-sepolia",
      privateKey: generatePrivateKey(),
    });
    const rpc = `http://127.0.0.1:${port}`,
      b = new Base(zeroAddress, 1, rpc, key),
      user = privateKeyToAccount(generatePrivateKey());
    let store = new SwapJournal(db);
    async function local(method: string, params: unknown[] = []): Promise<any> {
      const d = await (
        await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json();
      if (d.error) throw Error(JSON.stringify(d.error));
      return d.result;
    }
    async function send(
      _name: string,
      data: Hex,
      to?: `0x${string}`,
      value = 0n,
    ): Promise<TransactionReceipt> {
      const nonce = await b.public.getTransactionCount({
          address: b.account.address,
          blockTag: "pending",
        }),
        fees = await b.public.estimateFeesPerGas(),
        gas =
          ((await b.public.estimateGas({
            account: b.account.address,
            to,
            data,
            value,
          })) *
            12n) /
          10n;
      const raw = await b.wallet.signTransaction({
        account: b.account,
        chain: b.wallet.chain,
        to,
        data,
        value,
        nonce,
        gas,
        ...fees,
      });
      const hash = await b.broadcast(raw);
      return b.public.waitForTransactionReceipt({ hash });
    }
    try {
      for (let i = 0; i < 60; i++) {
        try {
          await b.chain();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      await local("anvil_setBalance", [b.account.address, toHex(10n ** 19n)]);
      // Anvil defaults to Ethereum priority fees; inject Base-like test fees only.
      b.public.estimateFeesPerGas = async () =>
        ({ maxFeePerGas: 10000000n, maxPriorityFeePerGas: 1000000n }) as any;
      const c = await infrastructure(
          send,
          b.account.address,
          user.address,
          b.public,
        ),
        adapter = new SwapBase(c, 1, rpc, key);
      adapter.public.estimateFeesPerGas = b.public.estimateFeesPerGas;
      const q = await quoted(c, 100000000000000n, b.public);
      const at = Math.floor(Date.now() / 1000),
        nonce = toHex(randomBytes(32));
      const i: UnsignedSwap = {
        kind: "swap",
        version: 1,
        chainId: 84532,
        contract: c.executor,
        orderId: toHex(randomBytes(32)),
        nonce,
        recipient: user.address,
        provider: c.provider,
        sourceNetwork: SOURCE,
        adapter: ADAPTER,
        target: c.router,
        maxNative: "100000000000000",
        price: "100000000000000",
        maxGas: BUDGET.toString(),
        gasBudget: BUDGET.toString(),
        zatoshis: zecCost(100000000000000n).toString(),
        expiry: at + 3500,
        refundHash: toHex(randomBytes(32)),
        inputAsset: c.weth,
        outputToken: c.token,
        decimals: 18,
        router: c.router,
        route: [c.weth, c.token],
        expectedOut: q.expectedOut.toString(),
        minOut: ((q.expectedOut * 99n) / 100n).toString(),
        slippageBps: 100,
        referenceBlock: q.block.number.toString(),
        referenceHash: q.block.hash!,
      };
      const signed: SwapIntent = {
          ...i,
          signature: await user.signTypedData(swapTyped(i)),
        },
        id = await signature(signed, c, at);
      assert.equal(
        await b.public.readContract({
          address: c.executor,
          abi: executorAbi,
          functionName: "intentId",
          args: [swapTyped(i).message],
        }),
        id,
      );
      for (const changed of [
        { chainId: 1 },
        { recipient: c.provider },
        { decimals: 6 },
        { outputToken: zeroAddress },
        { router: c.pool },
        { route: [c.token, c.weth] },
        { minOut: "1" },
        { slippageBps: 301 },
        { expiry: at - 1 },
      ])
        assert.throws(() => terms({ ...i, ...changed } as any, c, at));
      await assert.rejects(
        signature({ ...signed, maxNative: "1", price: "1" }, c, at),
      );
      const account = randomUUID();
      store.create(id, signed, account, "utest-synthetic-swap", at);
      const snapshot = (tip: number) => ({
        network: "zcash-testnet",
        tip,
        scanned: tip,
        observedAt: at,
        payments: [
          {
            account,
            txid: "ab".repeat(32),
            pool: 4,
            index: 0,
            zatoshis: i.zatoshis,
            height: 91,
            blockHash: "cd".repeat(32),
          },
        ],
      });
      store.observe(snapshot(99), at);
      await executeOne(store, id, adapter, () => at);
      assert.equal(store.get(id)!.tx_hash, null);
      store.observe(snapshot(100), at);
      const snap = await local("evm_snapshot");
      await executeOne(store, id, adapter, () => at);
      assert.equal(store.get(id)!.state, "settled");
      const o = store.get(id)!,
        r = await adapter.receipt(o);
      assert.equal(r.status, "success");
      if (r.status !== "success") throw Error("receipt");
      assert.equal(r.amountOut, i.expectedOut);
      const after = await inspect(c, b.public);
      assert.equal(after.reserveIn, q.reserveIn + BigInt(i.maxNative));
      assert.equal(after.reserveOut, q.reserveOut - BigInt(i.expectedOut));
      assert.equal(
        await b.public.readContract({
          address: c.token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [user.address],
        }),
        BigInt(i.expectedOut),
      );
      const providerNonce = await b.public.getTransactionCount({
        address: c.provider,
      });
      store.close();
      store = new SwapJournal(db);
      await executeOne(store, id, adapter, () => at);
      assert.equal(
        await b.public.getTransactionCount({ address: c.provider }),
        providerNonce,
      );
      await assert.rejects(
        b.public.simulateContract({
          account: c.provider,
          address: c.executor,
          abi: executorAbi,
          functionName: "execute",
          args: [swapTyped(i).message, swapParams(i), signed.signature],
          value: BigInt(i.maxNative),
        }),
      );
      const altered = {
        ...i,
        orderId: toHex(randomBytes(32)),
        nonce: toHex(randomBytes(32)),
      };
      const alteredSigned = {
        ...altered,
        signature: await user.signTypedData(swapTyped(altered)),
      };
      await assert.rejects(adapter.validate(alteredSigned), /slippage/);
      const id2 = await signature(alteredSigned, c, at),
        request = randomUUID();
      store.reserve(
        request,
        "o",
        "s",
        altered,
        "refund",
        randomUUID(),
        10n ** 18n,
        at,
      );
      store.create(
        id2,
        alteredSigned,
        randomUUID(),
        "utest-synthetic-failure",
        at,
      );
      store.db
        .prepare(
          "UPDATE purchase_requests SET order_id=?,stage='sent' WHERE id=?",
        )
        .run(id2, request);
      store.transition(id2, "verified", at);
      store.db
        .prepare("UPDATE orders SET observed_at=? WHERE id=?")
        .run(at, id2);
      store.db
        .prepare("INSERT INTO payments VALUES(?,?,?,?,?,1,1)")
        .run("synthetic", id2, i.zatoshis, 91, "ef".repeat(32));
      const service = new Swaps(
        store,
        {
          base: { user: user.address },
          zcash: {
            payer: { account: "synthetic", address: "utest-synthetic" },
          },
        },
        {
          allocate: async () => {
            throw Error("not used");
          },
          observe: async () => {
            throw Error("not used");
          },
        },
      );
      service.base = () => adapter;
      service.lockPath = join(dir, "service.lock");
      service.legacyPath = join(dir, "legacy.sqlite");
      // Inject the already-confirmed synthetic scan, but run actual pool validation and durable recovery.
      service.available = () => true;
      (service.scanner as any).observe = async () => ({
        network: "zcash-testnet",
        tip: 100,
        scanned: 100,
        observedAt: at,
        payments: [
          ...snapshot(100).payments,
          {
            account: store.get(id2)!.account,
            txid: "ef".repeat(32),
            pool: 4,
            index: 1,
            zatoshis: i.zatoshis,
            height: 91,
            blockHash: "cd".repeat(32),
          },
        ],
      });
      await service.tick();
      assert.equal(store.get(id2)!.state, "recovery");
      assert.ok(
        store.db.prepare("SELECT 1 FROM recoveries WHERE order_id=?").get(id2),
      );
      assert.equal(store.get(id2)!.tx_hash, null);
      await local("evm_revert", [snap]);
      assert.equal((await adapter.receipt(o)).status, "pending");
    } finally {
      store.close();
      child.kill();
    }
  },
);
