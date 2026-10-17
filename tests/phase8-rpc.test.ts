// Disposable public-chain responses only. No live key, signing or broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EvidenceReader,
  verificationConfig,
  type VerificationConfig,
} from "../services/execution/rpc-confidence.ts";
import { solanaReceiptEvidence } from "../services/solana/receipt-confidence.ts";
import { evmReceiptEvidence } from "../services/evm/receipt-confidence.ts";
import { GENESIS } from "../services/solana/network.ts";
import {
  SolanaSettlement,
  SolanaSettlementNetwork,
} from "../services/solana/settlement.ts";
import { Store } from "../services/execution/store.ts";
import { randomUUID } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { EvmAdapter } from "../services/evm/adapter.ts";
const sig = getBase58Decoder().decode(new Uint8Array(64).fill(1)),
  hash = `0x${"a".repeat(64)}`,
  key = "11111111111111111111111111111111";
const config = (secondary = true): VerificationConfig => ({
  primary: {
    endpoint: "https://primary.invalid/key-secret?token=secret",
    operator: "operator-a",
  },
  secondary: secondary
    ? {
        endpoint: "https://secondary.invalid/private-key",
        operator: "operator-b",
      }
    : undefined,
  independenceAcknowledged: true,
  timeoutMs: 30,
});
const sol = () => ({
  slot: 100,
  version: "legacy",
  transaction: {
    signatures: [sig],
    message: {
      accountKeys: [key],
      header: { numRequiredSignatures: 1 },
      recentBlockhash: key,
      instructions: [],
    },
  },
  meta: {
    err: null,
    fee: 5000,
    preBalances: [10000],
    postBalances: [5000],
    preTokenBalances: [],
    postTokenBalances: [
      {
        accountIndex: 0,
        mint: key,
        owner: key,
        uiTokenAmount: { amount: "76043880", decimals: 6 },
      },
    ],
    innerInstructions: [],
  },
});
const evm = () => ({
  transactionHash: hash,
  blockNumber: "0x64",
  blockHash: `0x${"b".repeat(64)}`,
  status: "0x1",
  transactionIndex: "0x0",
  from: `0x${"1".repeat(40)}`,
  to: `0x${"2".repeat(40)}`,
  contractAddress: null,
  gasUsed: "0x5208",
  effectiveGasPrice: "0x1",
  logs: [],
});
type Handler = (method: string, params: any[], secondary: boolean) => any;
function transport(change?: Handler) {
  const calls: { method: string; params: any[] }[] = [];
  const fetcher: typeof fetch = (async (url: any, init: any) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    const secondary = String(url).includes("secondary");
    const override = await change?.(method, params, secondary);
    let value = override;
    if (override === undefined)
      switch (method) {
        case "getGenesisHash":
          value = GENESIS;
          break;
        case "getTransaction":
          value = sol();
          break;
        case "getSignatureStatuses":
          value = {
            value: [{ slot: 100, err: null, confirmationStatus: "finalized" }],
          };
          break;
        case "getSlot":
          value = secondary ? 202 : 200;
          break;
        case "getBlock":
          value = { blockhash: key, previousBlockhash: key, parentSlot: 99 };
          break;
        case "eth_chainId":
          value = "0x14a34";
          break;
        case "eth_getTransactionReceipt":
          value = evm();
          break;
        case "eth_blockNumber":
          value = secondary ? "0xc9" : "0xc8";
          break;
        case "eth_getBlockByNumber":
          value = { hash: evm().blockHash, number: "0x64" };
          break;
        default:
          assert.fail(`Unexpected read method ${method}`);
      }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: value }),
    );
  }) as typeof fetch;
  return { fetcher, calls };
}
test("8C primary-only evidence is scoped and required corroboration fails closed", async () => {
  const t = transport(),
    c = config(false),
    reader = new EvidenceReader(c, t.fetcher);
  const result = await solanaReceiptEvidence(reader, sig);
  assert.equal(result.confidence.mode, "PRIMARY_ONLY");
  assert.ok(result.evidence);
  reader.assertAccepted(result);
  assert.throws(
    () =>
      new EvidenceReader(
        { ...c, requireCorroboration: true },
        t.fetcher,
      ).assertAccepted(result),
    /EVIDENCE_POLICY/,
  );
  assert.equal(result.confidence.scope, "SOLANA_FINALIZED_TRANSACTION");
});
test("8C independent Solana corroboration ignores different current finalized heads and cosmetic UI token formatting", async () => {
  const t = transport((m, _, peer) => {
    if (m === "getTransaction" && peer) {
      const r: any = sol();
      r.meta.postTokenBalances[0].uiTokenAmount.uiAmountString = "76.043880";
      return r;
    }
  });
  const result = await solanaReceiptEvidence(
    new EvidenceReader(config(), t.fetcher),
    sig,
  );
  assert.equal(result.confidence.mode, "CORROBORATED");
  assert.equal(result.confidence.providersChecked, 2);
});
test("8C secondary timeout is bounded and cannot become agreement", async () => {
  const t = transport((_, __, peer) =>
    peer ? new Promise(() => {}) : undefined,
  );
  const reader = new EvidenceReader(config(), t.fetcher);
  const r = await solanaReceiptEvidence(reader, sig);
  assert.equal(r.confidence.mode, "DEGRADED");
  assert.equal(r.confidence.providersChecked, 1);
  assert.equal(r.confidence.providerOutcomes[1], "TIMEOUT");
});
test("8C unavailable primary cannot be replaced by a responsive secondary", async () => {
  const t = transport((_, __, peer) =>
    !peer ? Promise.reject(Error("secret-url")) : undefined,
  );
  const r = await solanaReceiptEvidence(
    new EvidenceReader(config(), t.fetcher),
    sig,
  );
  assert.equal(r.confidence.mode, "DEGRADED");
  assert.equal(r.evidence, null);
});
test("8C conflicting finalized Solana slots are a material conflict", async () => {
  const t = transport((m, _, peer) => {
    if (peer && m === "getTransaction") return { ...sol(), slot: 101 };
    if (peer && m === "getSignatureStatuses")
      return {
        value: [{ slot: 101, err: null, confirmationStatus: "finalized" }],
      };
  });
  const r = await solanaReceiptEvidence(
    new EvidenceReader(config(), t.fetcher),
    sig,
  );
  assert.equal(r.confidence.mode, "CONFLICTED");
  assert.equal(r.evidence, null);
});
test("8C wrong devnet genesis rejects before requesting transaction data", async () => {
  const t = transport((m) =>
    m === "getGenesisHash" ? "wrong-genesis" : undefined,
  );
  const r = await solanaReceiptEvidence(
    new EvidenceReader(config(), t.fetcher),
    sig,
  );
  assert.equal(r.confidence.mode, "CONFLICTED");
  assert.equal(t.calls.length, 2);
});
test("8C changed token owner, mint, amount, native balance or message cannot corroborate", async () => {
  for (const mutate of [
    (r: any) => (r.meta.postTokenBalances[0].owner = "other-owner"),
    (r: any) => (r.meta.postTokenBalances[0].mint = "other-mint"),
    (r: any) => (r.meta.postTokenBalances[0].uiTokenAmount.amount = "76043881"),
    (r: any) => (r.meta.postBalances[0] = 4999),
    (r: any) =>
      (r.transaction.message.instructions = [
        { programIdIndex: 0, data: "bad", accounts: [] },
      ]),
  ]) {
    const t = transport((m, _, peer) => {
      if (peer && m === "getTransaction") {
        const r = sol();
        mutate(r);
        return r;
      }
    });
    assert.equal(
      (
        await solanaReceiptEvidence(
          new EvidenceReader(config(), t.fetcher),
          sig,
        )
      ).confidence.mode,
      "CONFLICTED",
    );
  }
});
test("8C null, pruned or not-yet-finalized peer evidence is degraded rather than a false conflict", async () => {
  for (const method of ["getTransaction", "getBlock", "getSignatureStatuses"]) {
    const t = transport((m, _, peer) =>
      peer && m === method
        ? m === "getSignatureStatuses"
          ? {
              value: [
                { slot: 100, err: null, confirmationStatus: "confirmed" },
              ],
            }
          : null
        : undefined,
    );
    assert.equal(
      (
        await solanaReceiptEvidence(
          new EvidenceReader(config(), t.fetcher),
          sig,
        )
      ).confidence.mode,
      "DEGRADED",
    );
  }
});
test("8C duplicate operators, same host and missing independence acknowledgement never corroborate", async () => {
  const t = transport();
  for (const c of [
    {
      ...config(),
      secondary: { ...config().secondary!, operator: "operator-a" },
    },
    {
      ...config(),
      secondary: {
        endpoint: "https://primary.invalid/another",
        operator: "operator-b",
      },
    },
    { ...config(), independenceAcknowledged: false },
  ])
    assert.equal(
      (await solanaReceiptEvidence(new EvidenceReader(c, t.fetcher), sig))
        .confidence.mode,
      "DEGRADED",
    );
});
test("8C EVM corroboration compares canonical receipt effects, tolerating different head heights", async () => {
  const t = transport(),
    r = await evmReceiptEvidence(
      new EvidenceReader(config(), t.fetcher),
      84532,
      hash,
    );
  assert.equal(r.confidence.mode, "CORROBORATED");
  assert.equal(r.confidence.scope, "EVM_CANONICAL_DEPTH_RECEIPT");
  assert.equal(r.evidence?.confirmations, "101");
});
test("8C EVM conflicting status or block identity is rejected", async () => {
  for (const change of [
    { status: "0x0" },
    { blockHash: `0x${"c".repeat(64)}` },
  ]) {
    const t = transport((m, _, peer) =>
      peer && m === "eth_getTransactionReceipt"
        ? { ...evm(), ...change }
        : undefined,
    );
    assert.equal(
      (
        await evmReceiptEvidence(
          new EvidenceReader(config(), t.fetcher),
          84532,
          hash,
        )
      ).confidence.mode,
      "CONFLICTED",
    );
  }
});
test("8C EVM wrong chain and insufficient peer depth cannot authorize corroborated evidence", async () => {
  const wrong = transport((m, _, peer) =>
    peer && m === "eth_chainId" ? "0x1" : undefined,
  );
  assert.equal(
    (
      await evmReceiptEvidence(
        new EvidenceReader(config(), wrong.fetcher),
        84532,
        hash,
      )
    ).confidence.mode,
    "CONFLICTED",
  );
  const lag = transport((m, _, peer) =>
    peer && m === "eth_blockNumber" ? "0x64" : undefined,
  );
  assert.equal(
    (
      await evmReceiptEvidence(
        new EvidenceReader(config(), lag.fetcher),
        84532,
        hash,
      )
    ).confidence.mode,
    "DEGRADED",
  );
  assert.throws(
    () =>
      evmReceiptEvidence(new EvidenceReader(config(), lag.fetcher), 1, hash),
    /unsupported_testnet/,
  );
});
test("8C credentials and cross-chain identifiers never appear in confidence or destination request bodies", async () => {
  const t = transport(),
    reader = new EvidenceReader(config(), t.fetcher);
  const r = await solanaReceiptEvidence(reader, sig);
  const exported = JSON.stringify(
    {
      evmAdapter: new EvmAdapter(84532, config()),
      solanaAdapter: new SolanaSettlementNetwork(undefined, config()),
      reader,
      confidence: r.confidence,
      requests: t.calls,
    },
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  for (const forbidden of [
    "key-secret",
    "token=secret",
    "private-key",
    "utest",
    "payment_digest",
    "order_id",
  ])
    assert.ok(!exported.includes(forbidden));
  assert.throws(
    () => solanaReceiptEvidence(reader, "utest1-source-reference"),
    /INVALID_DESTINATION/,
  );
  assert.throws(
    () =>
      new EvidenceReader({ primary: { endpoint: "secret-credential-url" } }),
    (e) => !String(e).includes("secret-credential-url"),
  );
  await assert.rejects(
    reader
      .verify("SOLANA_FINALIZED_TRANSACTION", async (rpc) => {
        await rpc("sendTransaction", []);
        return null;
      })
      .then((r) => {
        reader.assertAccepted(r);
      }),
    /EVIDENCE_POLICY/,
  );
});
test("8C verification policy is honored by existing Solana and EVM receipt adapters", async (context) => {
  context.mock.method(globalThis, "fetch", transport().fetcher);
  const n = new SolanaSettlementNetwork(undefined, {
    ...config(false),
    requireCorroboration: true,
    timeoutMs: 1,
  });
  await assert.rejects(n.receipt(sig), /EVIDENCE_POLICY/);
  const e = new EvmAdapter(84532, {
    ...config(false),
    requireCorroboration: true,
  });
  await assert.rejects(e.receipt(hash as `0x${string}`), /EVIDENCE_POLICY/);
  const good = new EvmAdapter(84532, {
    ...config(),
    requireCorroboration: true,
  });
  const receipt = await good.receipt(hash as `0x${string}`);
  assert.equal(receipt!.status, "success");
  assert.equal(receipt!.blockNumber, 100n);
});
test("8C restart of a completed disposable order still vetoes execution, preparation and refund without reading signer/network", async () => {
  const store = new Store(":memory:"),
    forbidden = new Proxy(
      {},
      {
        get() {
          assert.fail("Completed order accessed signer/network");
        },
      },
    );
  const service = new SolanaSettlement(store, forbidden as any, () => 100);
  const id = service.quote({
    profileId: randomUUID(),
    requestId: randomUUID(),
    recipient: "So11111111111111111111111111111111111111112",
    relayer: key,
    lamports: "1000000",
    account: "a".repeat(64),
    paymentAddress: "utest1_SYNTHETIC",
  }).id;
  store.db.prepare("UPDATE orders SET state='settled'").run();
  store.db
    .prepare("UPDATE solana_settlement SET state='COMPLETED',claimed=1")
    .run();
  const restarted = new SolanaSettlement(store, forbidden as any, () => 101);
  await assert.rejects(restarted.prepare(id));
  await assert.rejects(
    restarted.execute(
      id,
      { orderId: id, digest: "unapproved", approved: true },
      forbidden as any,
    ),
  );
  assert.throws(
    () => restarted.recover(id, "RPC_DISAGREEMENT"),
    /COMPLETED_DELIVERY_REFUND_VETO/,
  );
  assert.equal(
    store.db.prepare("SELECT state FROM solana_settlement").get()!.state,
    "COMPLETED",
  );
  store.close();
});
test("8C malformed, unsafe-number and oversized responses fail closed with finite redacted outcomes", async () => {
  const name = "ZECONE_TEST_8C_REQUIRE_CORROBORATION",
    prior = process.env[name];
  try {
    process.env[name] = "true";
    assert.throws(
      () => verificationConfig("ZECONE_TEST_8C", config().primary.endpoint),
      /INVALID_VERIFICATION_CONFIG/,
    );
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
  assert.throws(
    () =>
      new EvidenceReader({
        ...config(),
        independenceAcknowledged: "yes" as any,
      }),
    /INVALID_VERIFICATION_CONFIG/,
  );
  const malformed = transport((m) =>
    m === "getTransaction" ? { slot: 100, meta: null } : undefined,
  );
  const bad = await solanaReceiptEvidence(
    new EvidenceReader(config(false), malformed.fetcher),
    sig,
  );
  assert.equal(bad.confidence.mode, "CONFLICTED");
  assert.equal(bad.evidence, null);
  const unsafe = transport((m) =>
    m === "getTransaction"
      ? { ...sol(), slot: Number.MAX_SAFE_INTEGER + 1 }
      : undefined,
  );
  assert.equal(
    (
      await solanaReceiptEvidence(
        new EvidenceReader(config(false), unsafe.fetcher),
        sig,
      )
    ).confidence.mode,
    "CONFLICTED",
  );
  const oversized = (async () =>
    new Response("x".repeat(2 * 1024 * 1024 + 1))) as typeof fetch;
  const result = await solanaReceiptEvidence(
    new EvidenceReader({ ...config(false), timeoutMs: 1000 }, oversized),
    sig,
  );
  assert.equal(result.confidence.mode, "DEGRADED");
  assert.equal(result.confidence.providerOutcomes[0], "RESPONSE_TOO_LARGE");
  assert.ok(!JSON.stringify(result.confidence).includes("key-secret"));
});
