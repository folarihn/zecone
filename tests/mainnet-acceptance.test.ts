// Synthetic provider responses prove validation behavior, not mainnet readiness.
import test from "node:test";
import assert from "node:assert/strict";
import { getBase58Decoder } from "@solana/kit";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MainnetSubmissionJournal,
  readBaseFinalizedReceipt,
  readSolanaFinalizedReceipt,
} from "../services/settlement/mainnet-submitter.ts";
import {
  submitMainnetTransfer,
  verifiedMainnetSummary,
  type MainnetTransferTerms,
  type VerifiedMainnetBundle,
} from "../services/settlement/mainnet-transfer.ts";
import type { ProductionProfile } from "../services/settlement/production-safety.ts";
const providers = [
  { endpoint: "https://one.invalid", operator: "one" },
  { endpoint: "https://two.invalid", operator: "two" },
];
const profile = (network: "base" | "solana") =>
  ({ network, providers, independenceAcknowledged: true }) as ProductionProfile;
const terms = (
  network: "base" | "solana" = "solana",
): MainnetTransferTerms => ({
  version: 1,
  network,
  destinationNetwork: network === "base" ? "eip155:8453" : "solana:mainnet",
  relayer:
    network === "base"
      ? "0x1111111111111111111111111111111111111111"
      : "11111111111111111111111111111112",
  recipient:
    network === "base"
      ? "0x2222222222222222222222222222222222222222"
      : "11111111111111111111111111111113",
  amount: "1000000",
  feeCap: "10000",
  l1DataFeeBound: network === "base" ? "100" : "0",
  maximumDestinationDebit: "1010000",
  sourceNetwork: "zcash-mainnet",
  sourceZatoshis: "100000",
  sourcePaymentCommitment: "a".repeat(64),
  destinationBinding: "b".repeat(64),
  quoteDigest: "c".repeat(64),
  profileDigest: "d".repeat(64),
  expires: Math.floor(Date.now() / 1000) + 600,
});
const bundle = (
  network: "base" | "solana" = "solana",
): VerifiedMainnetBundle => ({
  version: 1,
  network,
  termsDigest: "e".repeat(64),
  preparedDigest: "f".repeat(64),
  signed: "SYNTHETIC_NOT_SIGNED",
  transactionId:
    network === "base" ? `0x${"a".repeat(64)}` : "AbC" + "s".repeat(84),
  signedDigest: "1".repeat(64),
  totalFee: "5000",
  broadcast: false,
});
function response(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
}
function baseRpc(
  override: (method: string, result: any, url: string) => any = (_m, r) => r,
): typeof fetch {
  return async (u, init) => {
    const { method, params } = JSON.parse(String(init?.body)),
      t = terms("base"),
      hash = "0x" + "9".repeat(64),
      r: any =
        method === "eth_chainId"
          ? "0x2105"
          : method === "eth_getTransactionReceipt"
            ? {
                status: "0x1",
                transactionHash: bundle("base").transactionId,
                blockHash: hash,
                blockNumber: "0x10",
                from: t.relayer,
                to: t.recipient,
                gasUsed: "0x1",
                effectiveGasPrice: "0x3",
                l1Fee: "0x2",
              }
            : method === "eth_getTransactionByHash"
              ? {
                  hash: bundle("base").transactionId,
                  chainId: "0x2105",
                  type: "0x0",
                  from: t.relayer,
                  to: t.recipient,
                  value: "0xf4240",
                  input: "0x",
                  blockHash: hash,
                  blockNumber: "0x10",
                }
              : method === "eth_call"
                ? "0x" + "0".repeat(64)
                : method === "eth_getBlockByNumber"
                  ? {
                      hash,
                      number: params[0] === "finalized" ? "0x20" : "0x10",
                      timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
                    }
                  : null;
    return response(override(method, r, String(u)));
  };
}
function solanaRpc(
  override: (method: string, result: any, url: string) => any = (_m, r) => r,
): typeof fetch {
  return async (u, init) => {
    const { method } = JSON.parse(String(init?.body)),
      t = terms(),
      data = Buffer.alloc(12);
    data.writeUInt32LE(2);
    data.writeBigUInt64LE(1000000n, 4);
    const r =
      method === "getGenesisHash"
        ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
        : method === "getTransaction"
          ? {
              version: "legacy",
              slot: 100,
              transaction: {
                signatures: [bundle().transactionId],
                message: {
                  header: {
                    numRequiredSignatures: 1,
                    numReadonlySignedAccounts: 0,
                    numReadonlyUnsignedAccounts: 1,
                  },
                  accountKeys: [
                    t.relayer,
                    t.recipient,
                    "11111111111111111111111111111111",
                  ],
                  recentBlockhash: "11111111111111111111111111111111",
                  instructions: [
                    {
                      programIdIndex: 2,
                      accounts: [0, 1],
                      data: getBase58Decoder().decode(data),
                    },
                  ],
                },
              },
              meta: {
                err: null,
                fee: 5000,
                preBalances: [2000000, 0, 0],
                postBalances: [995000, 1000000, 0],
              },
            }
          : null;
    return response(override(method, r, String(u)));
  };
}
test("Base receipt uses standard transaction value and canonical finalized block, not receipt.value", async () => {
  const r = await readBaseFinalizedReceipt(
    profile("base"),
    terms("base"),
    bundle("base").transactionId,
    baseRpc(),
  );
  assert.equal(r.value, "1000000");
  assert.equal(r.confirmations, 17);
  assert.ok(Object.isFrozen(r));
});
test("Base rejects wrong chain, noncanonical blocks, missing fee evidence and conflicting providers", async () => {
  for (const bad of ["chain", "block", "fee", "conflict"]) {
    await assert.rejects(
      readBaseFinalizedReceipt(
        profile("base"),
        terms("base"),
        bundle("base").transactionId,
        baseRpc((m, r, u) => {
          if (bad === "chain" && m === "eth_chainId") return "0x1";
          if (bad === "block" && m === "eth_getBlockByNumber")
            return { ...r, hash: "0x" + "8".repeat(64) };
          if (bad === "fee" && m === "eth_getTransactionReceipt") {
            delete r.l1Fee;
            return r;
          }
          if (
            bad === "conflict" &&
            u.includes("two") &&
            (m === "eth_getTransactionReceipt" ||
              m === "eth_getTransactionByHash" ||
              m === "eth_getBlockByNumber")
          )
            return {
              ...r,
              hash: "0x" + "8".repeat(64),
              blockHash: "0x" + "8".repeat(64),
            };
          return r;
        }),
      ),
    );
  }
});
test("Solana finality requires exact native transfer instruction and balance effects", async () => {
  const t = terms(),
    b = bundle(),
    j = new MainnetSubmissionJournal(":memory:", {
      perTransaction: "2000000",
      daily: "4000000",
      confirmations: 1,
    });
  try {
    assert.equal(j.isPaused, true);
    j.resume();
    j.prepare(t, b);
    j.claim(b.termsDigest);
    j.markBroadcast(b.termsDigest, b.transactionId);
    const r = await readSolanaFinalizedReceipt(
      profile("solana"),
      t,
      b.transactionId,
      solanaRpc(),
    );
    assert.ok(Object.isFrozen(r));
    j.finalizeSolana(b.termsDigest, r, t);
    assert.equal(j.status(b.termsDigest).state, "finalized");
    assert.throws(() => j.claim(b.termsDigest));
  } finally {
    j.close();
  }
});
test("Solana status alone, wrong recipient effects, wrong genesis and conflicting message cannot finalize", async () => {
  for (const bad of ["status", "effect", "chain", "conflict"]) {
    await assert.rejects(
      readSolanaFinalizedReceipt(
        profile("solana"),
        terms(),
        bundle().transactionId,
        solanaRpc((m, r, u) => {
          if (bad === "chain" && m === "getGenesisHash") return "wrong";
          if (m !== "getTransaction") return r;
          if (bad === "status")
            return { slot: 100, confirmationStatus: "finalized", err: null };
          if (bad === "effect") r.meta.postBalances[1] = 999999;
          if (bad === "conflict" && u.includes("two"))
            r.transaction.message.recentBlockhash = "different";
          return r;
        }),
      ),
    );
  }
});
test("journal preserves case-sensitive Solana IDs, custom order ID and uncertain restart claims", () => {
  const path = join(
      mkdtempSync(join(tmpdir(), "zecone-mainnet-accept-")),
      "orders.sqlite",
    ),
    limits = { perTransaction: "2000000", daily: "4000000", confirmations: 1 },
    t = terms(),
    b = bundle();
  let j = new MainnetSubmissionJournal(path, limits);
  j.resume();
  j.prepare(t, b, "custom-order");
  assert.equal(j.status("custom-order").transaction_id, b.transactionId);
  j.claim("custom-order");
  assert.throws(() => j.markFailed("custom-order"), /REQUIRES_RECONCILIATION/);
  assert.throws(
    () => j.markBroadcast("custom-order", b.transactionId.toLowerCase()),
    /ID_MISMATCH/,
  );
  j.markUncertain("custom-order", "lost response");
  j.close();
  j = new MainnetSubmissionJournal(path, limits);
  try {
    assert.equal(j.status("custom-order").state, "uncertain");
    assert.throws(() => j.claim("custom-order"));
    assert.throws(
      () =>
        j.prepare(
          { ...t, sourcePaymentCommitment: "2".repeat(64) },
          b,
          "custom-order",
        ),
      /CONFLICTING/,
    );
  } finally {
    j.close();
  }
});
test("failed unsubmitted orders never free their historical source payment for reuse", () => {
  const j = new MainnetSubmissionJournal(":memory:", {
    perTransaction: "2000000",
    daily: "4000000",
    confirmations: 1,
  });
  try {
    j.resume();
    const t = terms(),
      b = bundle();
    j.prepare(t, b);
    assert.throws(() => j.markFailed(b.termsDigest), /REQUIRES_RECONCILIATION/);
    j.db
      .prepare("UPDATE mainnet_submissions SET state='failed' WHERE order_id=?")
      .run(b.termsDigest);
    assert.throws(
      () =>
        j.prepare(t, {
          ...b,
          termsDigest: "2".repeat(64),
          transactionId: "3".repeat(88),
        }),
      /REPLAY/,
    );
  } finally {
    j.close();
  }
});
test("legacy metadata facade remains closed while authenticated executor is separate", () => {
  assert.throws(submitMainnetTransfer, /MAINNET_LIVE_EXECUTION_NOT_ACTIVATED/);
});

test("ordinary verified-bundle output excludes signed bytes and unsolicited secret fields", () => {
  const b = {
    ...bundle(),
    signed: "NEVER_LOG_SIGNED_BYTES",
    privateKey: "NEVER_LOG_SECRET",
  };
  const summary = JSON.stringify(verifiedMainnetSummary(b));
  assert.ok(!summary.includes(b.signed));
  assert.ok(!summary.includes(b.privateKey));
  assert.equal("signed" in verifiedMainnetSummary(b), false);
});
