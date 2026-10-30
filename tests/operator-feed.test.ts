import { test } from "node:test";
import assert from "node:assert/strict";
import { basePayoutCheck } from "../services/payments/operator-feed.ts";
import { OperatorWatchFeed } from "../services/payments/operator-feed.ts";
import { PaymentStore } from "../services/payments/store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TX = "0x" + "1".repeat(64);
const BLOCK_A = "0x" + "a".repeat(64);
const BLOCK_B = "0x" + "b".repeat(64);
const RELAYER = "0x0000000000000000000000000000000000000001";
const RECIPIENT = "0x0000000000000000000000000000000000000002";

function rpcFetcher(blockHashes = [BLOCK_A, BLOCK_A]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(input)).hostname;
    const index = host === "one.example" ? 0 : 1;
    const request = JSON.parse(String(init?.body)) as { method: string };
    const blockHash = blockHashes[index];
    const result: Record<string, unknown> = {
      eth_chainId: "0x2105",
      eth_getTransactionByHash: {
        hash: TX,
        from: RELAYER,
        to: RECIPIENT,
        value: "0x64",
        blockNumber: "0x64",
        blockHash,
      },
      eth_getTransactionReceipt: {
        transactionHash: TX,
        blockNumber: "0x64",
        blockHash,
        status: "0x1",
      },
      eth_getBlockByNumber: { number: "0x65", hash: "0x" + "f".repeat(64) },
    };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: result[request.method] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

test("Base payout verification requires independent credential-free HTTPS providers", () => {
  assert.throws(() => basePayoutCheck(["http://one.example", "https://two.example"], RELAYER), /BASE_PAYOUT_RPCS_REQUIRED/);
  assert.throws(() => basePayoutCheck(["https://one.example/a", "https://one.example/b"], RELAYER), /BASE_PAYOUT_RPCS_REQUIRED/);
  assert.throws(() => basePayoutCheck(["https://user:secret@one.example", "https://two.example"], RELAYER), /BASE_PAYOUT_RPCS_REQUIRED/);
});

test("operator heartbeat rejects duplicate sources and checkpoint regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "zecone-feed-"));
  const store = new PaymentStore(join(dir, "payments.sqlite"));
  const feed = new OperatorWatchFeed(store, {
    minimumConfirmations: 20,
    maxPayoutWei: 1000n,
    payout: { verify: async () => ({ block: 1, finalized: false }) },
    now: () => 1_800_000_000,
  });
  try {
    assert.throws(
      () => feed.heartbeat({ tip: 100, tipHash: "a".repeat(64), source: "RPC-A", peerSource: " rpc-a ", observedAt: 1_800_000_000 }),
      /HEARTBEAT_INVALID/,
    );
    feed.heartbeat({ tip: 100, tipHash: "a".repeat(64), source: "rpc-a", peerSource: "rpc-b", observedAt: 1_800_000_000 });
    assert.throws(
      () => feed.heartbeat({ tip: 99, tipHash: "b".repeat(64), source: "rpc-a", peerSource: "rpc-b", observedAt: 1_800_000_000 }),
      /HEARTBEAT_REGRESSION/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Base payout verification binds tx and receipt to the same block on every provider", async () => {
  const check = basePayoutCheck(["https://one.example", "https://two.example"], RELAYER, rpcFetcher());
  assert.deepEqual(await check.verify(TX, { to: RECIPIENT, wei: "100" }), { block: 100, finalized: true });

  const disagreement = basePayoutCheck(
    ["https://one.example", "https://two.example"],
    RELAYER,
    rpcFetcher([BLOCK_A, BLOCK_B]),
  );
  await assert.rejects(disagreement.verify(TX, { to: RECIPIENT, wei: "100" }), /BASE_PROVIDERS_DISAGREE/);
});
