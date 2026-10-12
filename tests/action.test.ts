// Local Anvil integration only: disposable EOA keys and synthetic scan fixture; no real funds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createPublicClient,
  http,
  encodeDeployData,
  parseEther,
  toHex,
  zeroAddress,
  hashTypedData,
  encodeFunctionData,
  parseAbi,
  keccak256,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ActionBase,
  actionTyped,
  verifyAction,
  type ActionIntent,
} from "../services/execution/action.ts";
import { Store } from "../services/execution/store.ts";
import { exclusiveJson, readJson } from "../services/execution/io.ts";
import { executeOne } from "../services/execution/worker.ts";

test(
  "local Anvil: fixed signed ZEC action settles once and confirms the exact user event",
  { timeout: 60_000 },
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
        "--silent",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const dir = mkdtempSync(join(tmpdir(), "zecone-action-")),
      keyFile = join(dir, "relayer.json"),
      rpc = `http://127.0.0.1:${port}`;
    const account = privateKeyToAccount(generatePrivateKey());
    exclusiveJson(keyFile, {
      network: "base-sepolia",
      privateKey: generatePrivateKey(),
    });
    const bootstrap = new ActionBase(zeroAddress, 1, rpc, keyFile);
    let store: Store | undefined;
    try {
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try {
          await bootstrap.chain();
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.ok(ready, "Anvil startup failed");
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "anvil_setBalance",
          params: [bootstrap.account.address, toHex(parseEther("1"))],
        }),
      });
      if (!response.ok) throw Error("fixture balance setup failed");
      const publicClient = createPublicClient({
          chain: baseSepolia,
          transport: http(rpc),
        }),
        artifact = readJson<{ abi: any; bytecode: { object: Hex } }>(
          "out/ZecOneActions.sol/ZecOneActions.json",
        ),
        deployment = await bootstrap.signed(
          encodeDeployData({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args: [bootstrap.account.address],
          }),
        );
      await bootstrap.broadcast(deployment.raw);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: deployment.hash,
      });
      assert.ok(receipt.contractAddress);
      const base = new ActionBase(receipt.contractAddress!, 1, rpc, keyFile),
        user = privateKeyToAccount(generatePrivateKey()),
        now = Math.floor(Date.now() / 1000);
      const unsigned: Omit<ActionIntent, "signature"> = {
        kind: "action",
        orderId: `0x${randomBytes(32).toString("hex")}` as Hex,
        nonce: "0x" as Hex,
        chainId: 84532,
        recipient: user.address,
        contract: receipt.contractAddress!,
        target: receipt.contractAddress!,
        data: "0x",
        maxValue: "0",
        maxGasBudget: "5000000000000000",
        zatoshis: "1000000",
        expiry: now + 3600,
      };
      unsigned.nonce = unsigned.orderId;
      const note = keccak256(toHex("ZecOne Phase 2 shielded sponsorship"));
      unsigned.data = encodeFunctionData({
        abi: parseAbi(["function recordFor(address account,bytes32 note)"]),
        functionName: "recordFor",
        args: [user.address, note],
      });
      const intent: ActionIntent = {
        ...unsigned,
        signature: await user.signTypedData(actionTyped(unsigned)),
      };
      const id = await verifyAction(
        intent,
        receipt.contractAddress!,
        bootstrap.account.address,
        now,
      );
      assert.equal(id, hashTypedData(actionTyped(unsigned)));
      const accountId = randomUUID();
      store = new Store(join(dir, "orders.sqlite"));
      store.create(id, intent, accountId, "utest-LOCAL-ACTION-SYNTHETIC", now);
      store.observe(
        {
          network: "zcash-testnet",
          tip: 100,
          scanned: 100,
          observedAt: now,
          payments: [
            {
              account: accountId,
              txid: randomBytes(32).toString("hex"),
              pool: 3,
              index: 0,
              zatoshis: "1000000",
              height: 91,
              blockHash: randomBytes(32).toString("hex"),
            },
          ],
        },
        now,
      );
      await executeOne(store, id, base, () => now);
      const settled = store.get(id)!;
      assert.equal(settled.state, "settled");
      assert.equal((await base.receipt(settled)).status, "success");
      assert.equal(
        await publicClient.readContract({
          address: receipt.contractAddress!,
          abi: artifact.abi,
          functionName: "records",
          args: [user.address],
        }),
        1n,
      );
      const nonce = await publicClient.getTransactionCount({
        address: bootstrap.account.address,
      });
      await executeOne(store, id, base, () => now);
      assert.equal(
        await publicClient.getTransactionCount({
          address: bootstrap.account.address,
        }),
        nonce,
      );
      await assert.rejects(
        verifyAction(
          { ...intent, recipient: bootstrap.account.address },
          receipt.contractAddress!,
          bootstrap.account.address,
          now,
        ),
      );
    } finally {
      store?.close();
      node.kill();
    }
  },
);
