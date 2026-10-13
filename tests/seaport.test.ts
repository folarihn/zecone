// Actual unmodified public Seaport 1.6 on a LOCAL Anvil fork. Payments are synthetic fixtures.
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
  getAddress,
  encodeFunctionData,
  keccak256,
  toHex,
  zeroAddress,
  zeroHash,
  type Hex,
  type Address,
} from "viem";
import { Base } from "../services/execution/base.ts";
import { exclusiveJson, readJson } from "../services/execution/io.ts";
import { executeOne } from "../services/execution/worker.ts";
import { nftAbi } from "../services/marketplace/purchase.ts";
import {
  SeaportJournal,
  SeaportPurchases,
} from "../services/seaport/service.ts";
import { infrastructure, unsignedListing } from "../services/seaport/setup.ts";
import { SeaportBase, verifyListing } from "../services/seaport/adapter.ts";
import {
  OpenSeaDiscovery,
  validateFulfillment,
} from "../services/seaport/opensea.ts";
import { toFunctionSignature } from "viem";
import { PurchaseJournal } from "../services/marketplace/journal.ts";
import {
  PROTOCOL,
  PROTOCOL_CODE,
  seaportAbi,
  executorAbi,
  components,
  advanced,
  orderTyped,
  orderHash,
  listingTerms,
  typed,
  terms,
  signature,
  SOURCE,
  ADAPTER,
  BUDGET,
  zecCost,
  type UnsignedSeaport,
  type SeaportIntent,
  type Listing,
} from "../services/seaport/protocol.ts";

test(
  "verified Seaport fork: restrictive fulfillment, payment gating, failures and restart",
  { timeout: 300000 },
  async (t) => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as any).port;
    await new Promise<void>((r) => server.close(() => r()));
    const pre = readJson<{ block: string }>(
        "docs/phase4c-evidence/seaport-preflight.json",
      ),
      rpc = `http://127.0.0.1:${port}`;
    const child = spawn(
      "anvil",
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--chain-id",
        "84532",
        "--fork-url",
        "https://sepolia.base.org",
        "--fork-block-number",
        pre.block,
        "--base-fee",
        "1000000",
        "--silent",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const dir = mkdtempSync(join(tmpdir(), "zecone-seaport-")),
      key = join(dir, "provider.json"),
      sellerKey = join(dir, "seller.json"),
      db = join(dir, "orders.sqlite");
    for (const f of [key, sellerKey])
      exclusiveJson(f, {
        network: "base-sepolia",
        privateKey: generatePrivateKey(),
      });
    const b = new Base(zeroAddress, 1, rpc, key),
      seller = new Base(zeroAddress, 1, rpc, sellerKey),
      user = privateKeyToAccount(generatePrivateKey());
    let store = new SeaportJournal(db);
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
    const fees = async () =>
      ({ maxFeePerGas: 10000000n, maxPriorityFeePerGas: 1000000n }) as any;
    async function send(w: Base, data: Hex, to?: Address, value = 0n) {
      const gas =
          ((await w.public.estimateGas({
            account: w.account.address,
            to,
            data,
            value,
          })) *
            12n) /
            10n +
          1n,
        nonce = await w.public.getTransactionCount({
          address: w.account.address,
          blockTag: "pending",
        });
      const raw = await w.wallet.signTransaction({
        account: w.account,
        chain: w.wallet.chain,
        to,
        data,
        value,
        gas,
        nonce,
        ...(await fees()),
      });
      const hash = await w.broadcast(raw);
      return w.public.waitForTransactionReceipt({ hash });
    }
    try {
      let ready = false;
      for (let n = 0; n < 100; n++) {
        try {
          await b.chain();
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      assert.ok(ready, "Anvil fork must start; no live success substitute");
      for (const address of [b.account.address, seller.account.address])
        await local("anvil_setBalance", [address, toHex(10n ** 19n)]);
      await local("evm_setNextBlockTimestamp", [Math.floor(Date.now() / 1000)]);
      await local("evm_mine");
      b.public.estimateFeesPerGas = fees;
      seller.public.estimateFeesPerGas = fees;
      const c = await infrastructure(
          (_name, data, to, value) => send(b, data, to, value),
          b.account.address,
          user.address,
          seller.account.address,
          b.public,
        ),
        adapter = new SeaportBase(c, 1, rpc, key);
      adapter.public.estimateFeesPerGas = fees;
      adapter.public.getBlockNumber = async () =>
        BigInt(await local("eth_blockNumber"));
      await send(
        seller,
        encodeFunctionData({
          abi: nftAbi,
          functionName: "setApprovalForAll",
          args: [PROTOCOL, true],
        }),
        c.nft,
      );
      const listing = await unsignedListing(c, b.public);
      listing.signature = await seller.account.signTypedData(
        orderTyped(listing),
      );
      const q = await verifyListing(listing, c, b.public),
        at = Math.floor(Date.now() / 1000);
      const i: UnsignedSeaport = {
        kind: "seaport",
        version: 1,
        chainId: 84532,
        contract: c.executor,
        orderId: toHex(randomBytes(32)),
        nonce: toHex(randomBytes(32)),
        sourceNetwork: SOURCE,
        adapter: ADAPTER,
        provider: c.provider,
        recipient: c.user,
        price: q.total.toString(),
        gasBudget: BUDGET.toString(),
        zatoshis: zecCost(q.total).toString(),
        expiry: at + 3500,
        refundHash: toHex(randomBytes(32)),
        listing,
        nft: c.nft,
        tokenId: q.tokenId,
        seller: c.seller,
        feeRecipient: c.feeRecipient,
        feeAmount: q.fee,
      };
      const signed: SeaportIntent = {
          ...i,
          signature: await user.signTypedData(typed(i)),
        },
        id = await signature(signed, c, at);
      const call = (intent = signed) => ({
        account: c.provider,
        address: c.executor,
        abi: executorAbi,
        functionName: "execute" as const,
        args: [
          typed(intent).message,
          advanced(intent.listing),
          BigInt(intent.listing.parameters.counter),
          intent.signature,
        ] as const,
        value: BigInt(intent.price),
      });
      await t.test(
        "official runtime, Seaport order hash and independent buyer digest match onchain",
        async () => {
          assert.equal(
            keccak256((await b.public.getBytecode({ address: PROTOCOL }))!),
            PROTOCOL_CODE,
          );
          assert.equal(
            await b.public.readContract({
              address: PROTOCOL,
              abi: seaportAbi,
              functionName: "getOrderHash",
              args: [components(listing.parameters)],
            }),
            orderHash(listing),
          );
          assert.equal(
            await b.public.readContract({
              address: c.executor,
              abi: executorAbi,
              functionName: "intentId",
              args: [typed(i).message],
            }),
            id,
          );
        },
      );
      await t.test(
        "documented API fulfillment is decoded and every recipient, fee and calldata change rejected",
        async () => {
          const value = JSON.parse(
            JSON.stringify(
              {
                protocol: "seaport",
                fulfillment_data: {
                  orders: [
                    {
                      parameters: {
                        ...components(listing.parameters),
                        totalOriginalConsiderationItems: 2,
                      },
                      signature: listing.signature,
                    },
                  ],
                  transaction: {
                    chain: 84532,
                    to: PROTOCOL,
                    value: q.total.toString(),
                    function: toFunctionSignature(
                      seaportAbi.find(
                        (x) =>
                          x.type === "function" &&
                          x.name === "fulfillAdvancedOrder",
                      ) as any,
                    ),
                    input_data: {
                      advancedOrder: advanced(listing),
                      criteriaResolvers: [],
                      fulfillerConduitKey: zeroHash,
                      recipient: c.user,
                    },
                  },
                },
              },
              (_k, v) => (typeof v === "bigint" ? v.toString() : v),
            ),
          );
          assert.equal(validateFulfillment(value, listing, c).value, q.total);
          for (const mutate of [
            (x: any) => (x.fulfillment_data.transaction.chain = 1),
            (x: any) =>
              (x.fulfillment_data.transaction.input_data.recipient =
                c.provider),
            (x: any) => (x.fulfillment_data.transaction.value = "1"),
            (x: any) =>
              (x.fulfillment_data.transaction.input_data.advancedOrder.parameters.consideration[1].startAmount =
                "1"),
            (x: any) =>
              (x.fulfillment_data.transaction.input_data.advancedOrder.parameters.totalOriginalConsiderationItems = 1),
            (x: any) =>
              (x.fulfillment_data.transaction.function = "fulfillOrder"),
            (x: any) =>
              (x.fulfillment_data.orders[0].parameters.counter = "99"),
            (x: any) =>
              (x.fulfillment_data.transaction.calldata_suffix = "0x12345678"),
          ]) {
            const changed = structuredClone(value);
            mutate(changed);
            assert.throws(() => validateFulfillment(changed, listing, c));
          }
        },
      );
      await t.test(
        "forged seller signature rejected independently and by genuine Seaport",
        async () => {
          const bad = {
            ...listing,
            signature: await user.signTypedData(orderTyped(listing)),
          };
          await assert.rejects(verifyListing(bad, c, b.public));
          await assert.rejects(
            b.public.simulateContract(call({ ...signed, listing: bad })),
          );
        },
      );
      for (const [name, change] of Object.entries({
        "wrong chain": { chainId: 1 },
        "wrong NFT": { nft: c.executor },
        "wrong seller": { seller: c.user },
        "wrong recipient": { recipient: c.provider },
        "expired quote": { expiry: at - 1 },
        "changed fee": { feeAmount: "1" },
        "excessive price": { price: "1000000000000000" },
        "wrong protocol domain": { adapter: zeroHash },
      }))
        await t.test(`${name} rejected`, async () => {
          const altered = { ...signed, ...change } as SeaportIntent;
          assert.throws(() => terms(altered, c, at));
          await assert.rejects(b.public.simulateContract(call(altered)));
        });
      await t.test(
        "unsupported orders and additional consideration rejected",
        async () => {
          for (const mutate of [
            (l: Listing) => (l.parameters.orderType = 1),
            (l: Listing) => (l.parameters.zone = c.user),
            (l: Listing) => (l.parameters.conduitKey = toHex(randomBytes(32))),
            (l: Listing) => (l.parameters.offer[0].itemType = 4),
            (l: Listing) =>
              l.parameters.offer.push({ ...l.parameters.offer[0] }),
            (l: Listing) => (l.parameters.consideration[0].endAmount = "2"),
            (l: Listing) => (l.parameters.consideration[1].recipient = c.user),
          ]) {
            const l = structuredClone(listing);
            mutate(l);
            l.orderHash = orderHash(l);
            assert.throws(() => listingTerms(l, c, at));
            await assert.rejects(
              b.public.simulateContract(call({ ...signed, listing: l })),
            );
          }
        },
      );
      await t.test(
        "calldata and recipient substitution fail despite original buyer signature",
        async () => {
          const args = [
            typed(i).message,
            { ...advanced(listing), numerator: 2n },
            BigInt(listing.parameters.counter),
            signed.signature,
          ] as const;
          await assert.rejects(b.public.simulateContract({ ...call(), args }));
          await assert.rejects(
            b.public.simulateContract({
              ...call(),
              args: [
                { ...typed(i).message, calldataHash: zeroHash },
                advanced(listing),
                BigInt(listing.parameters.counter),
                signed.signature,
              ],
            }),
          );
        },
      );
      async function isolated(fn: () => Promise<void>) {
        const snap = await local("evm_snapshot");
        try {
          await fn();
        } finally {
          await local("evm_revert", [snap]);
        }
      }
      await t.test("cancelled order is rejected", () =>
        isolated(async () => {
          await send(
            seller,
            encodeFunctionData({
              abi: seaportAbi,
              functionName: "cancel",
              args: [[components(listing.parameters)]],
            }),
            PROTOCOL,
          );
          await assert.rejects(
            verifyListing(listing, c, b.public),
            /listing_cancelled/,
          );
          await assert.rejects(b.public.simulateContract(call()));
        }),
      );
      await t.test("revoked seller approval is rejected", () =>
        isolated(async () => {
          await send(
            seller,
            encodeFunctionData({
              abi: nftAbi,
              functionName: "setApprovalForAll",
              args: [PROTOCOL, false],
            }),
            c.nft,
          );
          await assert.rejects(verifyListing(listing, c, b.public), /approval/);
        }),
      );
      await t.test("seller ownership change is rejected", () =>
        isolated(async () => {
          const artifact = readJson<any>(
            "out/MarketTestNFT.sol/MarketTestNFT.json",
          );
          await send(
            seller,
            encodeFunctionData({
              abi: artifact.abi,
              functionName: "transferFrom",
              args: [c.seller, c.user, 1n],
            }),
            c.nft,
          );
          await assert.rejects(
            verifyListing(listing, c, b.public),
            /ownership/,
          );
        }),
      );
      await t.test("onchain validated order can omit seller signature", () =>
        isolated(async () => {
          await send(
            seller,
            encodeFunctionData({
              abi: seaportAbi,
              functionName: "validate",
              args: [
                [
                  {
                    parameters: advanced(listing).parameters,
                    signature: listing.signature,
                  },
                ],
              ],
            }),
            PROTOCOL,
          );
          await verifyListing({ ...listing, signature: "0x" }, c, b.public);
        }),
      );
      await t.test("insufficient provider liquidity fails before signing", () =>
        isolated(async () => {
          await local("anvil_setBalance", [c.provider, toHex(1n)]);
          await assert.rejects(
            adapter.prepare({ id, intent: JSON.stringify(signed) } as any),
          );
        }),
      );
      const account = randomUUID();
      store.create(id, signed, account, "utest-synthetic-seaport", at);
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
      await t.test(
        "nine confirmations cannot authorize a Seaport transaction",
        async () => {
          store.observe(snapshot(99), at);
          await executeOne(store, id, adapter, () => at);
          assert.equal(store.get(id)!.tx_hash, null);
        },
      );
      const snap = await local("evm_snapshot"),
        sellerBefore = await b.public.getBalance({ address: c.seller }),
        userBefore = await b.public.getBalance({ address: c.user });
      await t.test(
        "ten confirmations fulfill the real protocol directly to the user and pay seller",
        async () => {
          store.observe(snapshot(100), at);
          await executeOne(store, id, adapter, () => at);
          assert.equal(store.get(id)!.state, "settled");
          assert.equal(
            await b.public.readContract({
              address: c.nft,
              abi: nftAbi,
              functionName: "ownerOf",
              args: [1n],
            }),
            getAddress(c.user),
          );
          assert.equal(
            (await b.public.getBalance({ address: c.seller })) - sellerBefore,
            100000000000000n,
          );
          assert.equal(
            await b.public.getBalance({ address: c.user }),
            userBefore,
          );
        },
      );
      await t.test(
        "replay and an already filled listing are rejected",
        async () => {
          await assert.rejects(b.public.simulateContract(call()));
          await assert.rejects(
            verifyListing(listing, c, b.public),
            /listing_sold/,
          );
        },
      );
      await t.test(
        "durable restart and duplicate settlement preserve hash and nonce",
        async () => {
          const old = store.get(id)!.tx_hash,
            nonce = await b.public.getTransactionCount({ address: c.provider });
          store.close();
          store = new SeaportJournal(db);
          await executeOne(store, id, adapter, () => at);
          assert.equal(store.get(id)!.tx_hash, old);
          assert.equal(
            await b.public.getTransactionCount({ address: c.provider }),
            nonce,
          );
        },
      );
      await t.test(
        "a paid unavailable listing remains an auditable recovery liability",
        async () => {
          const altered = {
            ...signed,
            orderId: toHex(randomBytes(32)),
            nonce: toHex(randomBytes(32)),
          };
          altered.signature = await user.signTypedData(typed(altered));
          const id2 = await signature(altered, c, at),
            request = randomUUID(),
            account2 = randomUUID();
          store.reserve(
            request,
            "o",
            "s",
            altered,
            "utest-refund",
            randomUUID(),
            10n ** 18n,
            at,
          );
          store.create(id2, altered, account2, "utest-synthetic-failed", at);
          store.db
            .prepare(
              "UPDATE purchase_requests SET order_id=?,stage='sent' WHERE id=?",
            )
            .run(id2, request);
          const service = new SeaportPurchases(
            store,
            {
              base: { user: c.user },
              zcash: {
                payer: { account: "synthetic", address: "utest-refund" },
              },
            },
            {
              allocate: async () => {
                throw Error("unused");
              },
              observe: async () => ({
                ...snapshot(100),
                payments: [
                  ...snapshot(100).payments,
                  {
                    ...snapshot(100).payments[0],
                    account: account2,
                    txid: "ef".repeat(32),
                  },
                ],
              }),
            },
          );
          service.base = () => adapter;
          service.available = () => true;
          service.lockPath = join(dir, "lock");
          service.legacyPath = join(dir, "legacy.sqlite");
          await service.tick();
          assert.equal(store.get(id2)!.state, "recovery");
          assert.equal(store.get(id2)!.tx_hash, null);
          assert.ok(
            store.db
              .prepare("SELECT 1 FROM recoveries WHERE order_id=?")
              .get(id2),
          );
        },
      );
      await t.test(
        "destination reorganization cannot be reported as verified delivery",
        async () => {
          await local("evm_revert", [snap]);
          assert.equal(
            (await adapter.receipt(store.get(id)!)).status,
            "pending",
          );
        },
      );
    } finally {
      store.close();
      child.kill();
      await once(child, "exit").catch(() => {});
    }
  },
);

test("OpenSea discovery respects testnet support, API authorization and rate-limit backoff", async () => {
  let calls = 0;
  const unsupported = new OpenSeaDiscovery(async () => {
    calls++;
    return new Response(JSON.stringify({ chains: [{ chain: "base" }] }), {
      status: 200,
    });
  }, "");
  await assert.rejects(
    unsupported.listings("test-collection"),
    /testnet_not_supported/,
  );
  await assert.rejects(
    unsupported.order(toHex(randomBytes(32))),
    /testnet_not_supported/,
  );
  assert.equal(calls, 1);
  const denied = new OpenSeaDiscovery(
    async () => new Response("", { status: 403 }),
    "",
  );
  await assert.rejects(denied.available(), /access_unavailable/);
  calls = 0;
  const limited = new OpenSeaDiscovery(async () => {
    calls++;
    return new Response("", { status: 429, headers: { "Retry-After": "60" } });
  }, "");
  await assert.rejects(limited.available(), /rate_limited/);
  await assert.rejects(limited.available(), /rate_limited/);
  assert.equal(calls, 1);
  await assert.rejects(
    unsupported.read("/api/v2/orders/base_sepolia/seaport/listings", {}),
    /read_only/,
  );
});
test("Seaport reservations share NFT liquidity and reject duplicate active protocol orders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seaport-reservations-")),
    db = join(dir, "p.sqlite"),
    s = new SeaportJournal(db),
    n = new PurchaseJournal(db);
  const i = {
    kind: "seaport",
    chainId: 84532,
    price: "60",
    gasBudget: "10",
    listing: { protocol: PROTOCOL, orderHash: toHex(randomBytes(32)) },
  };
  try {
    s.reserve(randomUUID(), "o", "s", i, "refund", randomUUID(), 100n, 1);
    assert.throws(
      () =>
        n.reserve(
          randomUUID(),
          "o",
          "s",
          { kind: "purchase", chainId: 84532, price: "30", gasBudget: "1" },
          "refund",
          randomUUID(),
          100n,
          1,
        ),
      /liquidity/,
    );
    assert.throws(
      () =>
        s.reserve(randomUUID(), "o", "s", i, "refund", randomUUID(), 1000n, 1),
      /UNIQUE/,
    );
    assert.equal(n.reserved(), 70n);
    assert.equal(n.rows().length, 0);
    assert.equal(s.rows().length, 1);
  } finally {
    s.close();
    n.close();
  }
});
test("unapproved Seaport sessions never reach signer, RPC or native payment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seaport-auth-")),
    s = new SeaportJournal(join(dir, "p.sqlite")),
    service = new SeaportPurchases(s, {
      base: { user: zeroAddress },
      zcash: { payer: { account: "synthetic", address: "utest-fixture" } },
    });
  let calls = 0;
  service.base = () => {
    calls++;
    throw Error("must not execute");
  };
  const session = {
    id: "s",
    csrf: "c",
    connected: 0,
    expires: Date.now() + 60000,
  };
  try {
    await assert.rejects(service.quote(session, { chainId: 84532 }));
    await assert.rejects(service.fee(session, randomUUID()));
    await assert.rejects(
      service.pay(
        { ...session, connected: 1 },
        randomUUID(),
        randomUUID(),
        false,
      ),
    );
    assert.equal(calls, 0);
  } finally {
    s.close();
  }
});

test("concurrent Seaport and NFT reservations cannot overspend shared provider liquidity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seaport-concurrent-")),
    db = join(dir, "p.sqlite"),
    seaport = new SeaportJournal(db),
    nft = new PurchaseJournal(db),
    manifest = {
      base: { user: zeroAddress },
      zcash: { payer: { account: "synthetic", address: "utest-fixture" } },
    },
    first = new SeaportPurchases(seaport, manifest),
    second = new SeaportPurchases(nft, manifest);
  first.lockPath = second.lockPath = join(dir, "service.lock");
  try {
    const attempts = await Promise.allSettled([
      first.withLock(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        seaport.reserve(
          randomUUID(),
          "o",
          "s",
          {
            kind: "seaport",
            chainId: 84532,
            price: "60",
            gasBudget: "10",
            listing: { protocol: PROTOCOL, orderHash: toHex(randomBytes(32)) },
          },
          "refund",
          randomUUID(),
          100n,
          1,
        );
      }),
      second.withLock(async () => {
        nft.reserve(
          randomUUID(),
          "o",
          "s",
          {
            kind: "purchase",
            chainId: 84532,
            price: "60",
            gasBudget: "10",
            marketplace: "fixture",
            listingId: "1",
          },
          "refund",
          randomUUID(),
          100n,
          1,
        );
      }),
    ]);
    assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = attempts.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    assert.match(rejected.reason.message, /insufficient_provider_liquidity/);
    assert.equal(seaport.reserved(), 70n);
    assert.equal(nft.reserved(), 70n);
  } finally {
    seaport.close();
    nft.close();
  }
});
