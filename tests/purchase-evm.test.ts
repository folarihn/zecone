// Real EVM execution on local Anvil with disposable keys; synthetic Zcash only.
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
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  toHex,
  zeroAddress,
  type Hex,
} from "viem";
import { Base } from "../services/execution/base.ts";
import { exclusiveJson, readJson } from "../services/execution/io.ts";
import {
  PurchaseBase,
  marketAbi,
  nftAbi,
  executorAbi,
  interpret,
  GAS_BUDGET,
  RATE,
  purchaseTyped,
  validateSignature,
  type UnsignedPurchase,
} from "../services/marketplace/purchase.ts";
import { PurchaseJournal } from "../services/marketplace/journal.ts";
test(
  "local EVM: ordinary wallet buy, viem/Solidity quote identity, shielded-funded delivery and replay",
  { timeout: 90000 },
  async () => {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((r) => listener.close(() => r()));
    const node = spawn(
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
    const dir = mkdtempSync(join(tmpdir(), "zecone-market-evm-")),
      key = join(dir, "relayer.json"),
      sellerKey = join(dir, "seller.json");
    exclusiveJson(key, {
      network: "base-sepolia",
      privateKey: generatePrivateKey(),
    });
    exclusiveJson(sellerKey, {
      network: "base-sepolia",
      privateKey: generatePrivateKey(),
    });
    const rpc = `http://127.0.0.1:${port}`,
      b = new Base(zeroAddress, 1, rpc, key),
      seller = new Base(zeroAddress, 1, rpc, sellerKey),
      user = privateKeyToAccount(generatePrivateKey()),
      store = new PurchaseJournal(join(dir, "p.sqlite"));
    try {
      for (let i = 0; i < 50; i++) {
        try {
          await b.chain();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      async function local(method: string, params: unknown[]) {
        const r = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        assert.ok(!((await r.json()) as any).error);
      }
      await local("anvil_setBalance", [b.account.address, toHex(10n ** 18n)]);
      await local("anvil_setBalance", [
        seller.account.address,
        toHex(10n ** 18n),
      ]);
      async function send(w: Base, data: Hex, to?: `0x${string}`, value = 0n) {
        const fees = {
            maxFeePerGas: 10000000n,
            maxPriorityFeePerGas: 1000000n,
          },
          gas = await w.public.estimateGas({
            account: w.account.address,
            to,
            data,
            value,
          });
        const raw = await w.wallet.signTransaction({
          account: w.account,
          chain: w.wallet.chain,
          to,
          data,
          value,
          nonce: await w.public.getTransactionCount({
            address: w.account.address,
          }),
          gas: (gas * 12n) / 10n + 1n,
          ...fees,
        });
        const hash = await w.broadcast(raw);
        return w.public.waitForTransactionReceipt({ hash });
      }
      async function deploy(name: string, args: unknown[] = []) {
        const a = readJson<any>(`out/${name}.sol/${name}.json`),
          r = await send(
            b,
            encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args }),
          );
        assert.equal(r.status, "success");
        return r.contractAddress!;
      }
      const marketplace = await deploy("TestMarketplace"),
        nft = await deploy("MarketTestNFT", [seller.account.address]),
        executor = await deploy("ZecOnePurchaseExecutor", [
          b.account.address,
          marketplace,
        ]),
        config = {
          marketplace,
          nft,
          executor,
          origin: "http://127.0.0.1:4322",
        },
        base = new PurchaseBase(config, 1, rpc, key),
        at = Math.floor(Date.now() / 1000);
      await send(
        seller,
        encodeFunctionData({
          abi: nftAbi,
          functionName: "setApprovalForAll",
          args: [marketplace, true],
        }),
        nft,
      );
      for (const id of [1n, 2n])
        await send(
          seller,
          encodeFunctionData({
            abi: marketAbi,
            functionName: "list",
            args: [nft, id, 100000000000000n, BigInt(at + 86400)],
          }),
          marketplace,
        );
      const before = await b.public.getBalance({
        address: seller.account.address,
      });
      await send(
        b,
        encodeFunctionData({
          abi: marketAbi,
          functionName: "buy",
          args: [2n, user.address],
        }),
        marketplace,
        100000000000000n,
      );
      assert.equal(
        await b.public.readContract({
          address: nft,
          abi: nftAbi,
          functionName: "ownerOf",
          args: [2n],
        }),
        user.address,
      );
      assert.equal(
        (await b.public.getBalance({ address: seller.account.address })) -
          before,
        100000000000000n,
      );
      const data = encodeFunctionData({
          abi: marketAbi,
          functionName: "buy",
          args: [1n, user.address],
        }),
        tx = {
          from: user.address,
          to: marketplace,
          data,
          value: toHex(100000000000000n),
          chainId: "0x14a34",
        };
      // Recipient has zero ETH: simulation uses provider as payer, never requires user gas.
      const parsed = await interpret(
        base.public,
        config,
        tx,
        user.address,
        b.account.address,
      );
      assert.equal(parsed.tokenId, "1");
      await assert.rejects(
        interpret(
          base.public,
          config,
          { ...tx, value: "0x1" },
          user.address,
          b.account.address,
        ),
      );
      const orderId = toHex(randomBytes(32));
      const i: UnsignedPurchase = {
        ...parsed,
        kind: "purchase",
        orderId,
        nonce: orderId,
        chainId: 84532,
        contract: executor,
        marketplace,
        nft,
        recipient: user.address,
        gasBudget: GAS_BUDGET.toString(),
        zatoshis: "1000000",
        rate: RATE.toString(),
        maxSlippageBps: "0",
        expiry: at + 3500,
        refundHash: keccak256(toHex("synthetic-refund")),
        originHash: keccak256(toHex(config.origin)),
      };
      const intent = {
          ...i,
          signature: await user.signTypedData(purchaseTyped(i)),
        },
        id = await validateSignature(intent, config, user.address, at);
      assert.equal(
        await base.public.readContract({
          address: executor,
          abi: executorAbi,
          functionName: "quoteId",
          args: [purchaseTyped(i).message],
        }),
        id,
      );
      const account = randomUUID();
      store.create(id, intent, account, "utest-SYNTHETIC", at);
      store.observe(
        {
          network: "zcash-testnet",
          tip: 100,
          scanned: 100,
          observedAt: at,
          payments: [
            {
              account,
              txid: randomBytes(32).toString("hex"),
              pool: 4,
              index: 0,
              zatoshis: i.zatoshis,
              height: 91,
              blockHash: randomBytes(32).toString("hex"),
            },
          ],
        },
        at,
      );
      // Anvil defaults to Ethereum priority fees, not Base's fee market. Inject only
      // the fee quote; signing, eth_call, gas estimation, execution and receipts are real.
      base.public.estimateFeesPerGas = async () =>
        ({
          maxFeePerGas: 1000000000n,
          maxPriorityFeePerGas: 1000000000n,
        }) as any;
      await assert.rejects(base.prepare(store.get(id)!), /gas_budget_exceeded/);
      base.public.estimateFeesPerGas = async () =>
        ({ maxFeePerGas: 10000000n, maxPriorityFeePerGas: 1000000n }) as any;
      const signed = await base.prepare(store.get(id)!);
      store.prepared(id, signed.raw, signed.hash, at);
      await base.broadcast(signed.raw);
      await base.public.waitForTransactionReceipt({ hash: signed.hash });
      assert.equal((await base.receipt(store.get(id)!)).status, "success");
      assert.equal(
        await base.public.readContract({
          address: nft,
          abi: nftAbi,
          functionName: "ownerOf",
          args: [1n],
        }),
        user.address,
      );
      await assert.rejects(base.prepare(store.get(id)!));
      await local("anvil_setChainId", [8453]);
      await assert.rejects(base.check());
    } finally {
      store.close();
      node.kill();
    }
  },
);
