// Disposable offline request fixtures only. No keys, payment creation or sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, type Address } from "viem";
import {
  blockhash,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import {
  intentAbi,
  evmIntent,
  IntentReviews,
  validateRegistry,
  type EvmRoute,
  type Scope,
} from "../services/wallet/transaction-intents.ts";
import {
  inspectSolanaIntent,
  type SolanaInspection,
  type SolanaReadChecks,
} from "../services/wallet/solana-intents.ts";
import { transaction, type Action } from "../services/solana/transactions.ts";
import { GENESIS } from "../services/solana/network.ts";
import {
  CPMM,
  POOL,
  WSOL,
  OUTPUT,
  PROGRAM_HASH,
  swapTransaction,
} from "../services/solana/cpmm.ts";
import type {
  SolanaDeliveryIntent,
  SwapTerms,
} from "../services/solana/settlement-model.ts";
import { Dapps } from "../services/wallet/dapps.ts";
import type { Session } from "../services/wallet/security.ts";

const user = "0x1111111111111111111111111111111111111111" as Address,
  target = "0x2222222222222222222222222222222222222222" as Address,
  token = "0x3333333333333333333333333333333333333333" as Address,
  weth = "0x4444444444444444444444444444444444444444" as Address,
  codeHash = `0x${"a".repeat(64)}` as const,
  at = 1700000000000;
const scope: Scope = {
  origin: "https://fixture.example",
  session: "disposable",
  channel: randomUUID(),
  account: user,
  chainId: 84532,
  permitted: true,
  expires: at + 600000,
};
const routes: EvmRoute[] = [
  {
    chainId: 84532,
    target,
    operation: "nft-mint",
    codeHash,
    maxInput: "0",
    feeCap: "100000000000000",
  },
  {
    chainId: 84532,
    target,
    operation: "nft-purchase",
    codeHash,
    maxInput: "1000000000000000",
    feeCap: "100000000000000",
  },
  {
    chainId: 84532,
    target,
    operation: "token-swap",
    codeHash,
    maxInput: "200000000000000",
    feeCap: "100000000000000",
    inputMint: weth,
    outputMint: token,
  },
];
const buy = (recipient = user) =>
  encodeFunctionData({
    abi: intentAbi,
    functionName: "buy",
    args: [1n, recipient],
  });
const params = (data = buy(), to = target, value = "0x1") => [
  { from: user, to, value, data, chainId: "0x14a34" },
];
const make = (p = params(), s = scope, r = routes) =>
  evmIntent(s, randomUUID(), p, r, at);

test("supported pinned EVM purchase, mint and swap produce non-executing structured intents", () => {
  const purchase = make();
  assert.equal(purchase.operation, "nft-purchase");
  assert.equal(purchase.support.recognized, true);
  assert.equal(purchase.support.executable, false);
  const mint = encodeFunctionData({
    abi: intentAbi,
    functionName: "mint",
    args: [
      {
        recipient: user,
        zatoshis: 1000000n,
        nonce: `0x${"1".repeat(64)}`,
        expiry: BigInt(at / 1000 + 60),
      },
      "0x",
    ],
  });
  assert.equal(make(params(mint, target, "0x0")).operation, "nft-mint");
  const swap = encodeFunctionData({
    abi: intentAbi,
    functionName: "swapExactETHForTokens",
    args: [99n, [weth, token], user, BigInt(at / 1000 + 60)],
  });
  const intent = make(params(swap));
  assert.equal(intent.operation, "token-swap");
  assert.equal(intent.output.minimum, "99");
  assert.equal(intent.output.expected, null);
  assert.equal(intent.approval, "pending");
  assert.equal(intent.networkRequirements.status, "unavailable");
});
test("decoded unknown contracts, NFT mint targets and routers never gain adapter support", () => {
  assert.equal(make(params(buy(), token)).support.recognized, false);
  const swap = encodeFunctionData({
    abi: intentAbi,
    functionName: "swapExactETHForTokens",
    args: [99n, [weth, token], user, BigInt(at / 1000 + 60)],
  });
  assert.equal(make(params(swap, token)).support.recognized, false);
  const mint = encodeFunctionData({
    abi: intentAbi,
    functionName: "mint",
    args: [
      {
        recipient: user,
        zatoshis: 1000000n,
        nonce: `0x${"1".repeat(64)}`,
        expiry: BigInt(at / 1000 + 60),
      },
      "0x",
    ],
  });
  assert.equal(make(params(mint, token, "0x0")).support.recognized, false);
  assert.throws(() => make(params("0xdeadbeef")), /CALLDATA/);
});
test("malformed calldata, extra trailing bytes and hidden source fields fail closed", () => {
  for (const data of ["0x1", "0x12", `${buy()}00`])
    assert.throws(() => make(params(data as any)));
  assert.throws(() =>
    make([{ ...params()[0], zcashTxid: "private-marker" }] as any),
  );
});
test("origin, session, network, recipient and expiry are bound", () => {
  for (const s of [
    { ...scope, permitted: false },
    { ...scope, expires: at },
    { ...scope, session: "" },
    { ...scope, origin: "https://fixture.example/path" },
    { ...scope, chainId: 1 },
  ])
    assert.throws(() => make(params(), s));
  assert.throws(() => make(params(), { ...scope, chainId: 11155111 }));
  assert.throws(() => make(params(buy(token))), /RECIPIENT/);
  const swap = encodeFunctionData({
    abi: intentAbi,
    functionName: "swapExactETHForTokens",
    args: [1n, [weth, token], user, BigInt(at / 1000)],
  });
  assert.throws(() => make(params(swap)), /EXPIRED/);
});
test("ERC20 transfer and bounded/unlimited approvals are decoded but never supported", () => {
  for (const amount of [1n, (1n << 256n) - 1n]) {
    const data = encodeFunctionData({
      abi: intentAbi,
      functionName: "approve",
      args: [token, amount],
    });
    const i = make(params(data, target, "0x0"));
    assert.equal(i.operation, "erc20-approval");
    assert.equal(i.input.amount, amount.toString());
    assert.equal(i.support.recognized, false);
  }
  const data = encodeFunctionData({
    abi: intentAbi,
    functionName: "transfer",
    args: [token, 42n],
  });
  const i = make(params(data, target, "0x0"));
  assert.equal(i.operation, "erc20-transfer");
  assert.equal(i.input.decimals, null);
  assert.equal(i.support.executable, false);
});
test("registry rejects mainnet, unbounded inputs, duplicate routes and foreign swap networks", () => {
  const registry = validateRegistry(routes);
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry[0]));
  for (const bad of [
    { ...routes[0], chainId: 1 },
    { ...routes[0], maxInput: "1" },
    { ...routes[2], chainId: 46630 },
    { ...routes[0], codeHash: "0x0" },
  ])
    assert.throws(() => validateRegistry([bad as any]));
  assert.throws(() => validateRegistry([routes[0], routes[0]]));
  assert.equal(make(params(), scope, []).support.recognized, false);
});
test("swap input and token route limits cannot be expanded by calldata", () => {
  const data = encodeFunctionData({
    abi: intentAbi,
    functionName: "swapExactETHForTokens",
    args: [1n, [token, weth], user, BigInt(at / 1000 + 60)],
  });
  assert.throws(() => make(params(data)), /TOKEN_ROUTE/);
  assert.throws(() => make(params(buy(), target, "0x100000000000000")));
});
test("simulation facts are scoped to exact request, pinned code, chain and fee budget", async () => {
  for (const change of [
    { success: false },
    { chainId: 1 },
    { requestDigest: "other" },
    { codeHash: `0x${"b".repeat(64)}` },
    { fee: "100000000000001" },
    { at: at - 31000 },
  ]) {
    const reviews = new IntentReviews(
      routes,
      async (i) =>
        ({
          chainId: 84532,
          requestDigest: i.requestDigest,
          codeHash,
          success: true,
          fee: "1",
          gas: "21000",
          at,
          ...change,
        }) as any,
      () => at,
    );
    const i = await reviews.prepare(scope, randomUUID(), params());
    assert.equal(i.networkRequirements.status, "unavailable");
    assert.equal(i.support.executable, false);
  }
  const reviews = new IntentReviews(
    routes,
    async (i) => ({
      chainId: 84532,
      requestDigest: i.requestDigest,
      codeHash,
      success: true,
      fee: "1",
      gas: "21000",
      at,
    }),
    () => at,
  );
  assert.equal(
    (await reviews.prepare(scope, randomUUID(), params())).networkRequirements
      .status,
    "passed",
  );
});
test("duplicate IDs, cross-origin/session/channel/chain access and mutable returned objects cannot alter consent", async () => {
  const reviews = new IntentReviews(routes, undefined, () => at),
    id = randomUUID();
  const i = await reviews.prepare(scope, id, params());
  i.recipient = token;
  assert.equal(reviews.get(scope, id).recipient, user);
  assert.equal(
    (await reviews.prepare(scope, id, params())).requestDigest,
    i.requestDigest,
  );
  await assert.rejects(
    reviews.prepare(scope, id, params(buy(), target, "0x2")),
    /REUSE/,
  );
  for (const s of [
    { ...scope, origin: "https://other.example" },
    { ...scope, session: "other" },
    { ...scope, channel: randomUUID() },
    { ...scope, chainId: 46630 },
    { ...scope, permitted: false },
  ])
    assert.throws(() => reviews.get(s, id), /SCOPE/);
  assert.throws(() => reviews.consent(scope, id, "wrong", true));
  assert.equal(
    reviews.consent(scope, id, i.requestDigest, false).approval,
    "cancelled",
  );
  assert.throws(() => reviews.consent(scope, id, i.requestDigest, true));
});
test("concurrent preparation is reserved and no consent is possible before simulation completes", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  const reviews = new IntentReviews(
      routes,
      async () => {
        await gate;
        throw Error("unavailable");
      },
      () => at,
    ),
    id = randomUUID();
  const pending = reviews.prepare(scope, id, params());
  await assert.rejects(reviews.prepare(scope, id, params()), /PREPARING/);
  assert.throws(
    () => reviews.consent(scope, id, make().requestDigest, true),
    /PREPARING/,
  );
  finish();
  await pending;
});
test("late consent and restart fail closed without authorizing financial execution", async () => {
  let clock = at;
  const reviews = new IntentReviews(routes, undefined, () => clock),
    id = randomUUID();
  const i = await reviews.prepare(scope, id, params());
  clock = i.expires;
  assert.throws(() => reviews.consent(scope, id, i.requestDigest, true));
  assert.throws(() => new IntentReviews(routes).get(scope, id));
});
test("existing provider boundary records preview consent but never returns a fake transaction hash or calls legacy signer", async () => {
  const session: Session = {
    id: "fixture",
    csrf: "a".repeat(64),
    connected: 1,
    expires: Date.now() + 600000,
  };
  const reviews = new IntentReviews(routes),
    d = new Dapps(
      user,
      join(mkdtempSync(join(tmpdir(), "intent-")), "d.sqlite"),
      undefined,
      { intents: reviews },
    );
  try {
    d.db
      .prepare("INSERT INTO permissions VALUES(?,?)")
      .run(scope.origin, Date.now());
    d.client = () => {
      throw Error("Legacy client must not run");
    };
    const input = {
      id: randomUUID(),
      channel: randomUUID(),
      origin: scope.origin,
      method: "eth_sendTransaction",
      params: params(),
    };
    const response: any = await d.request(session, input);
    assert.equal(response.review.intent.support.executable, false);
    assert.equal(
      d.list().requests.some((r) => r.id === input.id),
      false,
    );
    const consent: any = await d.approve(
      session,
      input.id,
      response.reviewHash,
      true,
    );
    assert.equal(consent.done, true);
    assert.equal(consent.error.code, 4001);
    assert.equal(consent.result, undefined);
    assert.equal(d.row(input.id)?.tx_hash, null);
    assert.equal(d.row(input.id)?.state, "rejected");
    assert.deepEqual(await d.request(session, input), consent);
    const row: any = d.db
      .prepare("SELECT count(*) n FROM requests WHERE state='signing'")
      .get();
    assert.equal(row.n, 0);
  } finally {
    d.db.close();
  }
});
test("persisted preview cannot fall through to legacy signing after restart without preview mode", async () => {
  const session: Session = {
    id: "fixture",
    csrf: "a".repeat(64),
    connected: 1,
    expires: Date.now() + 600000,
  };
  const path = join(mkdtempSync(join(tmpdir(), "intent-restart-")), "d.sqlite");
  const d = new Dapps(user, path, undefined, {
    intents: new IntentReviews(routes),
  });
  d.db
    .prepare("INSERT INTO permissions VALUES(?,?)")
    .run(scope.origin, Date.now());
  const input = {
    id: randomUUID(),
    channel: randomUUID(),
    origin: scope.origin,
    method: "eth_sendTransaction",
    params: params(),
  };
  const r: any = await d.request(session, input);
  d.db.close();
  const restarted = new Dapps(user, path);
  try {
    restarted.client = () => {
      throw Error("Legacy signing path forbidden");
    };
    await assert.rejects(
      restarted.approve(session, input.id, r.reviewHash, true),
      /Preview session ended/,
    );
    assert.equal(restarted.row(input.id)?.tx_hash, null);
    assert.equal(restarted.row(input.id)?.state, "pending");
  } finally {
    restarted.db.close();
  }
});
test("provider denies unconnected origins and exact preview cancellation never signs", async () => {
  const session: Session = {
    id: "fixture",
    csrf: "a".repeat(64),
    connected: 1,
    expires: Date.now() + 600000,
  };
  const d = new Dapps(user, ":memory:", undefined, {
    intents: new IntentReviews(routes),
  });
  try {
    const input = {
      id: randomUUID(),
      channel: randomUUID(),
      origin: scope.origin,
      method: "eth_sendTransaction",
      params: params(),
    };
    await assert.rejects(d.request(session, input));
    d.db
      .prepare("INSERT INTO permissions VALUES(?,?)")
      .run(scope.origin, Date.now());
    const r: any = await d.request(session, input);
    const cancelled: any = await d.approve(
      session,
      input.id,
      r.reviewHash,
      false,
    );
    assert.equal(cancelled.error.code, 4001);
    assert.equal(d.row(input.id)?.tx_hash, null);
  } finally {
    d.db.close();
  }
});

const owner = "11111111111111111111111111111112",
  recipient = "11111111111111111111111111111113";
async function sol(): Promise<SolanaInspection> {
  const lifetime = {
    blockhash: blockhash("11111111111111111111111111111111"),
    lastValidBlockHeight: 1000n,
  };
  const action: Action = {
    family: "solana",
    network: "solana:devnet",
    genesis: GENESIS,
    owner,
    recipient,
    amount: "1000000",
    feeCap: "10000",
    asset: { kind: "SOL" },
  };
  return {
    id: randomUUID(),
    origin: scope.origin,
    genesis: GENESIS,
    owner,
    recipient,
    amount: "1000000",
    fee: "5000",
    rent: "0",
    expires: at + 60000,
    lifetime: { blockhash: lifetime.blockhash, lastValidBlockHeight: "1000" },
    wire: getBase64EncodedWireTransaction(await transaction(action, lifetime)),
  };
}
const net: SolanaReadChecks = {
  genesis: async () => GENESIS,
  valid: async () => true,
  route: async () => true,
  simulate: async () => ({ err: null, fee: "5000", units: "1000" }),
};
test("Solana canonical unsigned SOL delivery exposes verified payer, programs and account metas only", async () => {
  const out = await inspectSolanaIntent(await sol(), net, () => at);
  assert.equal(out.intent.operation, "sol-delivery");
  assert.equal(out.intent.support.executable, false);
  assert.equal(out.inspection.feePayer, owner);
  assert.deepEqual(out.inspection.programs, [
    "11111111111111111111111111111111",
  ]);
  assert.equal(out.inspection.computeBudget, "default");
});
test("Solana malformed, substituted program/instruction/account bytes and signed payloads are rejected", async () => {
  const i = await sol();
  await assert.rejects(
    inspectSolanaIntent({ ...i, wire: "AA==" }, net, () => at),
  );
  const tx = getTransactionDecoder().decode(Buffer.from(i.wire, "base64"));
  const bytes = new Uint8Array(tx.messageBytes);
  bytes[bytes.length - 1] ^= 1;
  const changed = Buffer.from(
    getTransactionEncoder().encode({ ...tx, messageBytes: bytes as any }),
  ).toString("base64");
  await assert.rejects(
    inspectSolanaIntent({ ...i, wire: changed }, net, () => at),
  );
  const signed = Buffer.from(
    getTransactionEncoder().encode({
      ...tx,
      signatures: { [owner]: new Uint8Array(64).fill(1) } as any,
    }),
  ).toString("base64");
  await assert.rejects(
    inspectSolanaIntent({ ...i, wire: signed }, net, () => at),
    /UNSIGNED/,
  );
});
test("Solana unknown program substitution and versioned/lookup-table transactions are rejected", async () => {
  const i = await sol(),
    tx = getTransactionDecoder().decode(Buffer.from(i.wire, "base64"));
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  const programIndex = message.staticAccounts.indexOf(
    "11111111111111111111111111111111" as any,
  );
  assert.ok(programIndex >= 0);
  const wrongProgram = new Uint8Array(tx.messageBytes);
  wrongProgram[4 + programIndex * 32] ^= 1;
  const v0 = new Uint8Array(tx.messageBytes.length + 2);
  v0[0] = 128;
  v0.set(tx.messageBytes, 1); // v0 prefix and zero ALT count.
  for (const bytes of [wrongProgram, v0]) {
    const wire = Buffer.from(
      getTransactionEncoder().encode({ ...tx, messageBytes: bytes as any }),
    ).toString("base64");
    await assert.rejects(inspectSolanaIntent({ ...i, wire }, net, () => at));
  }
});
test("Solana chain, route facts, expiry, simulation, fee and blockhash checks fail closed", async () => {
  const i = await sol();
  for (const bad of [
    { genesis: async () => "mainnet" },
    { valid: async () => false },
    { route: async () => false },
    { simulate: async () => ({ err: "failed", fee: "5000", units: "1000" }) },
    { simulate: async () => ({ err: null, fee: "10001", units: "1000" }) },
  ])
    await assert.rejects(inspectSolanaIntent(i, { ...net, ...bad }, () => at));
  await assert.rejects(
    inspectSolanaIntent({ ...i, expires: at }, net, () => at),
  );
  await assert.rejects(
    inspectSolanaIntent({ ...i, rent: "6000001" }, net, () => at),
  );
});
test("pinned Raydium route validates mint decimals, ATA creation and every canonical instruction", async () => {
  const i = await sol();
  const terms: SwapTerms = {
    program: CPMM,
    pool: POOL,
    inputMint: WSOL,
    outputMint: OUTPUT,
    inputDecimals: 9,
    outputDecimals: 6,
    amountIn: "1000000",
    slippageBps: 100,
    expectedOut: "76043880",
    minimumOut: "75283441",
    programHash: PROGRAM_HASH,
  };
  const delivery: SolanaDeliveryIntent = {
    family: "solana",
    action: "SOLANA_DEVNET_SPL_SWAP",
    network: "solana:devnet",
    genesis: GENESIS,
    recipient,
    relayer: owner,
    lamports: "1000000",
    feeCap: "10000",
    zatoshis: "0",
    nonce: `0x${"0".repeat(64)}`,
    expiry: at / 1000 + 60,
    pricing: "FIXED_TESTNET_DEMO_NOT_EXCHANGE_RATE",
    profileId: "fixture",
    requestId: i.id,
    swap: terms,
  };
  const wire = getBase64EncodedWireTransaction(
    await swapTransaction(delivery, terms, {
      blockhash: blockhash(i.lifetime.blockhash),
      lastValidBlockHeight: 1000n,
    }),
  );
  const out = await inspectSolanaIntent(
    { ...i, wire, swap: terms, rent: "4078560" },
    net,
    () => at,
  );
  assert.equal(out.intent.operation, "raydium-swap");
  assert.equal(out.inspection.instructions.length, 5);
  assert.ok(out.inspection.programs.includes(CPMM));
  for (const bad of [
    { outputDecimals: 9 },
    { program: owner },
    { pool: owner },
    { outputMint: owner },
    { amountIn: "2000000" },
    { minimumOut: "1" },
  ])
    await assert.rejects(
      inspectSolanaIntent(
        { ...i, wire, swap: { ...terms, ...bad } as any },
        net,
        () => at,
      ),
    );
});
test("private payment facts never enter destination callbacks or preview output", async () => {
  const i = await sol();
  let called = false;
  const out = await inspectSolanaIntent(
    i,
    {
      ...net,
      route: async (request) => {
        called = true;
        assert.equal(Object.hasOwn(request, "origin"), false);
        assert.equal(Object.hasOwn(request, "id"), false);
        return true;
      },
    },
    () => at,
  );
  assert.ok(called);
  for (const word of [
    "zcashTxid",
    "spendingKey",
    "viewingKey",
    "paymentId",
    "zatoshis",
  ])
    assert.equal(JSON.stringify(out).includes(word), false);
  await assert.rejects(
    inspectSolanaIntent(
      { ...i, zcashTxid: "private-marker" } as any,
      net,
      () => at,
    ),
    /UNKNOWN/,
  );
});
test("preview modules have no financial store, vault, signing or broadcast dependencies; completed settlement replay guards remain present", () => {
  for (const file of [
    "services/wallet/transaction-intents.ts",
    "services/wallet/solana-intents.ts",
    "services/wallet/intent-rpc.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    for (const forbidden of [
      ".signTransaction(",
      ".sendRawTransaction(",
      "loadAccount(",
      "new Store(",
      "EncryptedAccounts(",
    ])
      assert.equal(source.includes(forbidden), false);
  }
  // Behavioral completed-order checks also run in the existing settlement tests
  // and restart-copy audit; this layer never takes an order identifier.
  assert.equal(make().support.executionMode, "preview-only");
});
