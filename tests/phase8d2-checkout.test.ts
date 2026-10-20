// Disposable independent-read fixtures. No live keys, payment allocation or sends.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import {
  PurchaseIntentQuote,
  type PurchaseQuoteConfig,
} from "../services/wallet/purchase-intent-quote.ts";
import { IntentCheckout } from "../services/wallet/intent-checkout.ts";
import {
  IntentReviews,
  intentAbi,
} from "../services/wallet/transaction-intents.ts";
import { Dapps } from "../services/wallet/dapps.ts";
import { Sessions, type Session } from "../services/wallet/security.ts";
import { api } from "../services/wallet/api.ts";
import { priceZatoshis } from "../services/marketplace/purchase.ts";
const addr = (n: number) => `0x${n.toString().repeat(40)}` as Address;
const user = addr(1),
  market = addr(2),
  executor = addr(3),
  nft = addr(4),
  seller = addr(5),
  relayer = addr(6),
  origin = "https://purchase-fixture.example";
const codes = {
  marketplace: "0x6001",
  executor: "0x6002",
  nft: "0x6003",
} as const;
const config: PurchaseQuoteConfig = {
  market: { chainId: 84532, marketplace: market, executor, nft, origin },
  relayer,
  codeHashes: {
    marketplace: keccak256(codes.marketplace),
    executor: keccak256(codes.executor),
    nft: keccak256(codes.nft),
  },
  route: {
    chainId: 84532,
    target: market,
    operation: "nft-purchase",
    codeHash: keccak256(codes.marketplace),
    maxInput: "1000000000000000",
    feeCap: "100000000000000",
  },
};
async function fixture(t: TestContext, path = ":memory:") {
  let now = Date.now();
  const state = {
    price: 100000000000000n,
    chain: 84532,
    owner: seller,
    approval: market,
    active: true,
    fee: 10000000n,
    gas: 100000n,
    hash: `0x${"a".repeat(64)}` as Hex,
    secondaryPrice: null as bigint | null,
    secondaryHash: null as Hex | null,
    codeBad: false,
    simulationFails: false,
    inventory: 100000000000000000n,
    slippage: 0,
  };
  const calls: unknown[] = [];
  const client = (secondary = false): any => ({
    getChainId: async () => state.chain,
    getBlock: async () => ({
      number: 10n,
      hash: secondary && state.secondaryHash ? state.secondaryHash : state.hash,
      timestamp: BigInt(Math.floor(now / 1000)),
    }),
    getBytecode: async (args: any) => {
      calls.push({ method: "code", ...args });
      return state.codeBad
        ? "0x6000"
        : args.address === market
          ? codes.marketplace
          : args.address === executor
            ? codes.executor
            : codes.nft;
    },
    readContract: async (args: any) => {
      calls.push({ method: args.functionName, ...args });
      switch (args.functionName) {
        case "relayer":
          return relayer;
        case "marketplace":
          return market;
        case "getListing":
          return {
            nft,
            tokenId: 7n,
            seller,
            price:
              secondary && state.secondaryPrice !== null
                ? state.secondaryPrice
                : state.price,
            expiry: BigInt(Math.floor(now / 1000) + 7200),
            active: state.active,
          };
        case "ownerOf":
          return state.owner;
        case "getApproved":
          return state.approval;
        case "isApprovedForAll":
          return false;
        case "sold":
          return true;
        default:
          throw Error("Unexpected contract read");
      }
    },
    call: async (args: any) => {
      calls.push({ method: "call", ...args });
      if (state.simulationFails) throw Error("simulation");
      return {};
    },
    estimateGas: async (args: any) => {
      calls.push({ method: "gas", ...args });
      return state.gas;
    },
    estimateFeesPerGas: async () => ({
      maxFeePerGas: state.fee,
      maxPriorityFeePerGas: 1n,
    }),
    getBalance: async () => state.inventory,
  });
  const primary = client(),
    secondary = client(true),
    adapter = new PurchaseIntentQuote(config, primary, secondary, () => now);
  const ledger = new IntentCheckout(path, adapter, () => now);
  const d = new Dapps(user, ":memory:", undefined, {
    intents: new IntentReviews([config.route], undefined, () => now),
    checkoutPreview: ledger,
    signingDisabled: true,
  });
  t.after(() => {
    d.db.close();
    ledger.db.close();
  });
  const s: Session = {
    id: "synthetic-session",
    csrf: "a".repeat(64),
    connected: 1,
    expires: now + 600000,
  };
  d.db.prepare("INSERT INTO permissions VALUES(?,?)").run(origin, now);
  const id = randomUUID(),
    channel = randomUUID();
  const params = [
    {
      from: user,
      to: market,
      value: `0x${state.price.toString(16)}`,
      data: encodeFunctionData({
        abi: intentAbi,
        functionName: "buy",
        args: [1n, user],
      }),
      chainId: "0x14a34",
    },
  ];
  const preview: any = await d.request(s, {
    id,
    channel,
    origin,
    method: "eth_sendTransaction",
    params,
  });
  const consent = () => d.approve(s, id, preview.reviewHash, true);
  const context = d.checkoutContext(s, id);
  return {
    d,
    s,
    id,
    state,
    primary,
    secondary,
    adapter,
    ledger,
    params,
    context,
    consent,
    calls,
    setNow: (value: number) => (now = value),
    now: () => now,
  };
}
test("connection and preview are insufficient; quote requires distinct exact intent consent", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.d.quoteIntent(f.s, f.id));
  await f.consent();
  const q = await f.d.quoteIntent(f.s, f.id);
  assert.equal(q.terms.zatoshis, priceZatoshis(f.state.price).toString());
  assert.equal(q.terms.priceWei, f.state.price.toString());
  assert.equal(q.executionAuthorized, false);
  assert.equal(q.terms.slippageBps, 0);
  assert.equal(q.evidence, "two-configured-read-clients-agree");
  q.terms.priceWei = "0";
  assert.notEqual(f.ledger.view(f.context, q.id).terms.priceWei, "0");
  assert.ok(f.calls.every((c: any) => c.blockNumber === 10n));
});
test("exact quote review is separate from explicit dry-run checkout creation", async (t) => {
  const f = await fixture(t);
  await f.consent();
  const q = await f.d.quoteIntent(f.s, f.id);
  await assert.rejects(
    f.d.createIntentCheckoutPreview(f.s, f.id, q.id, q.digest, true),
  );
  assert.equal(
    f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, true).checkoutCreated,
    false,
  );
  await assert.rejects(
    f.d.createIntentCheckoutPreview(f.s, f.id, q.id, q.digest, false),
  );
  const handoff = await f.d.createIntentCheckoutPreview(
    f.s,
    f.id,
    q.id,
    q.digest,
    true,
  );
  assert.equal(handoff.mode, "dry-run");
  assert.equal(handoff.state, "USER_REVIEW");
  assert.equal(handoff.kind, "purchase");
  assert.equal(handoff.recipient, user);
  assert.equal(handoff.tokenId, "7");
  assert.equal(handoff.financialCheckoutCreated, false);
  assert.equal(handoff.paymentRequestCreated, false);
  assert.equal(handoff.executionAuthorized, false);
  assert.equal(handoff.paymentAddress, null);
  assert.equal(f.d.intentCheckoutStatus(f.s, f.id).state, "HANDOFF_READY");
});
test("expired quote, stale digest and cancelled review never create handoffs", async (t) => {
  const f = await fixture(t);
  await f.consent();
  const q = await f.d.quoteIntent(f.s, f.id);
  assert.throws(() => f.d.reviewIntentQuote(f.s, f.id, q.id, "old", true));
  f.setNow(q.expires);
  assert.throws(
    () => f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, true),
    /EXPIRED/,
  );
  f.setNow(q.expires - 1);
  f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, false);
  await assert.rejects(
    f.d.createIntentCheckoutPreview(f.s, f.id, q.id, q.digest, true),
  );
});
test("fresh quote supersedes earlier approval without overwriting history", async (t) => {
  const f = await fixture(t);
  await f.consent();
  const first = await f.d.quoteIntent(f.s, f.id);
  f.d.reviewIntentQuote(f.s, f.id, first.id, first.digest, true);
  const fresh = await f.d.quoteIntent(f.s, f.id);
  assert.notEqual(fresh.id, first.id);
  assert.notEqual(fresh.digest, first.digest);
  assert.throws(() =>
    f.d.reviewIntentQuote(f.s, f.id, first.id, first.digest, true),
  );
  await assert.rejects(
    f.d.createIntentCheckoutPreview(f.s, f.id, fresh.id, first.digest, true),
  );
  assert.equal(
    (
      f.ledger.db
        .prepare("SELECT state FROM intent_quotes WHERE id=?")
        .get(first.id) as any
    ).state,
    "SUPERSEDED",
  );
});
test("dApp supplied price is checked against fresh listing and cannot set ZEC cost", async (t) => {
  const f = await fixture(t);
  await f.consent();
  f.state.price += 1n;
  await assert.rejects(f.d.quoteIntent(f.s, f.id));
  assert.equal(f.d.intentCheckoutStatus(f.s, f.id).state, "REQUOTE_REQUIRED");
});
test("price or fee changes after quote review fail closed and retain recovery evidence", async (t) => {
  for (const key of ["price", "fee"] as const) {
    const f = await fixture(t);
    await f.consent();
    const q = await f.d.quoteIntent(f.s, f.id);
    f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, true);
    f.state[key] += 1n;
    await assert.rejects(
      f.d.createIntentCheckoutPreview(f.s, f.id, q.id, q.digest, true),
      /RECONCILIATION/,
    );
    assert.equal(
      f.d.intentCheckoutStatus(f.s, f.id).state,
      "RECOVERY_REQUIRED",
    );
    assert.equal(f.d.intentCheckoutStatus(f.s, f.id).handoff, null);
  }
});
test("provider disagreement and wrong chain cannot produce approved quotes", async (t) => {
  const f = await fixture(t);
  await f.consent();
  f.state.secondaryPrice = f.state.price + 1n;
  await assert.rejects(f.d.quoteIntent(f.s, f.id));
  f.state.secondaryPrice = null;
  f.state.secondaryHash = `0x${"b".repeat(64)}`;
  await assert.rejects(f.d.quoteIntent(f.s, f.id));
  f.state.secondaryHash = null;
  f.state.chain = 1;
  await assert.rejects(f.d.quoteIntent(f.s, f.id));
});
test("unknown mapping, mainnet, excessive fees and relayer-as-recipient are rejected", async (t) => {
  const f = await fixture(t);
  await f.consent();
  assert.throws(
    () => new Dapps(user, ":memory:", undefined, { checkoutPreview: f.ledger }),
  );
  for (const method of [
    "personal_sign",
    "eth_signTypedData_v4",
    "zecone_payWithZec",
  ])
    await assert.rejects(
      f.d.request(f.s, {
        id: randomUUID(),
        channel: randomUUID(),
        origin,
        method,
        params: [],
      }),
    );
  const unsupportedId = randomUUID();
  const unsupported: any = await f.d.request(f.s, {
    id: unsupportedId,
    channel: randomUUID(),
    origin,
    method: "eth_sendTransaction",
    params: [
      {
        ...f.params[0],
        value: "0x0",
        data: encodeFunctionData({
          abi: intentAbi,
          functionName: "transfer",
          args: [user, 1n],
        }),
      },
    ],
  });
  const unsupportedConsent: any = await f.d.approve(
    f.s,
    unsupportedId,
    unsupported.reviewHash,
    true,
  );
  assert.equal(unsupportedConsent.previewConsentRecorded, undefined);
  assert.throws(
    () =>
      new PurchaseIntentQuote(
        { ...config, market: { ...config.market, chainId: 1 as any } },
        f.primary,
        f.secondary,
      ),
  );
  assert.throws(
    () =>
      new PurchaseIntentQuote(
        { ...config, route: { ...config.route, target: nft } },
        f.primary,
        f.secondary,
      ),
  );
  assert.throws(() => new PurchaseIntentQuote(config, f.primary, f.primary));
  assert.throws(
    () =>
      new PurchaseIntentQuote(
        { ...config, route: { ...config.route, feeCap: "50000000000000" } },
        f.primary,
        f.secondary,
      ),
  );
  const c = f.context();
  await assert.rejects(
    f.adapter.quote({ ...c.scope, account: relayer }, c.intent, c.params),
  );
  f.state.fee = 100000001n;
  await assert.rejects(f.d.quoteIntent(f.s, f.id));
});
test("code changes, seller ownership, approvals, sold listing and simulation failures reject", async (t) => {
  const cases = [
    (s: any) => (s.codeBad = true),
    (s: any) => (s.owner = user),
    (s: any) => (s.approval = user),
    (s: any) => (s.active = false),
    (s: any) => (s.simulationFails = true),
    (s: any) => (s.inventory = 0n),
    (s: any) => (s.gas = 600001n),
  ];
  for (const mutate of cases) {
    const f = await fixture(t);
    await f.consent();
    mutate(f.state);
    await assert.rejects(f.d.quoteIntent(f.s, f.id));
  }
});
test("purchase permits zero slippage only and rejects swap/ambiguous calldata", async (t) => {
  const f = await fixture(t);
  await f.consent();
  const c = f.context();
  const swap = encodeFunctionData({
    abi: intentAbi,
    functionName: "swapExactETHForTokens",
    args: [1n, [user, nft], user, BigInt(Math.floor(f.now() / 1000) + 60)],
  });
  await assert.rejects(
    f.adapter.quote(c.scope, c.intent, [{ ...f.params[0], data: swap }]),
  );
  await assert.rejects(
    f.adapter.quote(c.scope, c.intent, [{ ...f.params[0], slippageBps: 100 }]),
  );
  await assert.rejects(
    f.adapter.quote(c.scope, c.intent, [
      { ...f.params[0], data: `${f.params[0].data}00` },
    ]),
  );
});
test("wrong recipient and changed request bytes cannot reuse canonical intent", async (t) => {
  const f = await fixture(t);
  await f.consent();
  const c = f.context();
  const wrong = encodeFunctionData({
    abi: intentAbi,
    functionName: "buy",
    args: [1n, seller],
  });
  await assert.rejects(
    f.adapter.quote(c.scope, c.intent, [{ ...f.params[0], data: wrong }]),
  );
  await assert.rejects(
    f.adapter.quote(c.scope, { ...c.intent, recipient: seller }, c.params),
  );
  await assert.rejects(
    f.adapter.quote(c.scope, c.intent, [{ ...f.params[0], value: "0x2" }]),
  );
});
test("origin, session, chain, permission and session loss invalidate quote consent", async (t) => {
  const f = await fixture(t);
  await f.consent();
  const q = await f.d.quoteIntent(f.s, f.id);
  assert.throws(() =>
    f.d.reviewIntentQuote({ ...f.s, id: "other" }, f.id, q.id, q.digest, true),
  );
  const c = f.context();
  assert.throws(() =>
    f.ledger.review(
      () => ({ ...c, scope: { ...c.scope, origin: "https://other.example" } }),
      q.id,
      q.digest,
      true,
    ),
  );
  f.d.db
    .prepare("INSERT INTO origin_networks VALUES(?,?)")
    .run(origin, 11155111);
  assert.throws(() => f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, true));
  f.d.db.prepare("DELETE FROM origin_networks").run();
  f.d.revoke(origin);
  assert.throws(() => f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, true));
  f.d.db.prepare("INSERT INTO permissions VALUES(?,?)").run(origin, f.now());
  assert.throws(() => f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, true));
  f.s.connected = 0;
  await assert.rejects(f.d.quoteIntent(f.s, f.id));
});
test("concurrent quotes and checkout creation each have one durable claim", async (t) => {
  const f = await fixture(t);
  await f.consent();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    original = f.primary.call;
  f.primary.call = async (args: any) => {
    await gate;
    return original(args);
  };
  const pending = f.d.quoteIntent(f.s, f.id);
  await assert.rejects(f.d.quoteIntent(f.s, f.id));
  release();
  const q = await pending;
  f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, true);
  const create = f.d.createIntentCheckoutPreview(
    f.s,
    f.id,
    q.id,
    q.digest,
    true,
  );
  await assert.rejects(
    f.d.createIntentCheckoutPreview(f.s, f.id, q.id, q.digest, true),
  );
  await create;
  assert.equal(
    (
      f.ledger.db
        .prepare(
          "SELECT COUNT(*) n FROM intent_audit WHERE event='DRY_RUN_CHECKOUT_AUTHORIZED'",
        )
        .get() as any
    ).n,
    1,
  );
});
test("duplicate authorization and completed handoff replay are rejected", async (t) => {
  const f = await fixture(t);
  await f.consent();
  const q = await f.d.quoteIntent(f.s, f.id);
  f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, true);
  assert.throws(() => f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, true));
  await f.d.createIntentCheckoutPreview(f.s, f.id, q.id, q.digest, true);
  await assert.rejects(
    f.d.createIntentCheckoutPreview(f.s, f.id, q.id, q.digest, true),
  );
  await assert.rejects(f.d.quoteIntent(f.s, f.id));
  assert.throws(() => f.d.checkoutContext(f.s, `0x${"b".repeat(64)}`)());
});
test("restart preserves completed preview but never promotes it to financial authority", async (t) => {
  const path = join(
      mkdtempSync(join(tmpdir(), "intent-checkout-")),
      "dry.sqlite",
    ),
    f = await fixture(t, path);
  await f.consent();
  const q = await f.d.quoteIntent(f.s, f.id);
  f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, true);
  await f.d.createIntentCheckoutPreview(f.s, f.id, q.id, q.digest, true);
  const restarted = new IntentCheckout(path, f.adapter, f.now);
  t.after(() => restarted.db.close());
  assert.equal(restarted.status(f.context).state, "HANDOFF_READY");
  assert.equal(restarted.status(f.context).executionAuthorized, false);
  await assert.rejects(restarted.create(f.context, q.id, q.digest, true));
});
test("interrupted creation and preparation fail closed after restart without automatic resume", async (t) => {
  for (const status of ["CREATING", "PREPARING"]) {
    const path = join(
        mkdtempSync(join(tmpdir(), "intent-interrupt-")),
        "dry.sqlite",
      ),
      f = await fixture(t, path);
    await f.consent();
    await f.d.quoteIntent(f.s, f.id);
    f.ledger.db.prepare("UPDATE intent_checkouts SET status=?").run(status);
    const restarted = new IntentCheckout(path, f.adapter, f.now);
    t.after(() => restarted.db.close());
    assert.equal(restarted.status(f.context).state, "RECOVERY_REQUIRED");
    await assert.rejects(restarted.quote(f.context));
  }
});
test("an unrelated or historical SQLite database is not opened for writes", async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), "not-dry-")), "wallet.sqlite"),
    db = new DatabaseSync(path);
  db.exec("CREATE TABLE sentinel(id INTEGER)");
  db.close();
  const f = await fixture(t);
  assert.throws(() => new IntentCheckout(path, f.adapter), /NOT_A_DRY_RUN/);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    (
      check
        .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'")
        .get() as any
    ).n,
    1,
  );
  check.close();
});
test("session revocation during async preparation cannot finalize a quote or handoff", async (t) => {
  const f = await fixture(t);
  await f.consent();
  const old = f.primary.call;
  f.primary.call = async (args: any) => {
    f.d.revoke(origin);
    return old(args);
  };
  await assert.rejects(f.d.quoteIntent(f.s, f.id));
  assert.equal(
    (f.ledger.db.prepare("SELECT COUNT(*) n FROM intent_quotes").get() as any)
      .n,
    0,
  );
});
test("source payment facts never enter read calls, quote or checkout output", async (t) => {
  const f = await fixture(t);
  await f.consent();
  const q = await f.d.quoteIntent(f.s, f.id);
  f.d.reviewIntentQuote(f.s, f.id, q.id, q.digest, true);
  const h = await f.d.createIntentCheckoutPreview(
    f.s,
    f.id,
    q.id,
    q.digest,
    true,
  );
  // viem ABI schemas are local metadata, not JSON-RPC parameters. Inspect the
  // destination arguments rather than treating schema names as leaked values.
  const calls = f.calls.map((call: any) => {
    const { abi, ...destination } = call;
    return destination;
  });
  const output = JSON.stringify({ q, h, calls }, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  for (const field of [
    "paymentId",
    "zcashTxid",
    "viewingKey",
    "spendingKey",
    "refundHash",
    "paymentAccount",
  ])
    assert.equal(output.includes(field), false);
  for (const file of [
    "services/wallet/intent-checkout.ts",
    "services/wallet/purchase-intent-quote.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    for (const needle of [
      ".signTransaction(",
      ".sendRawTransaction(",
      ".allocate(",
      "new Purchases(",
      "new PurchaseBase(",
      "new Store(",
    ])
      assert.equal(src.includes(needle), false);
  }
});
test("authenticated local HTTP handoff enforces CSRF and never calls live checkout", async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(":memory:"),
    sessions = new Sessions(db),
    pair = sessions.pair(sessions.issuePairing());
  sessions.db
    .prepare("UPDATE sessions SET connected=1 WHERE id=?")
    .run(pair.session.id);
  const id = randomUUID();
  const poison = new Proxy(
    {},
    {
      get() {
        throw Error("Live engine must never be accessed");
      },
    },
  );
  const server = createServer(api(sessions, poison as any, f.d));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const port = (server.address() as any).port;
  const post = (path: string, body: unknown, csrf = pair.session.csrf) =>
    new Promise<{ status: number; data: any }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            Host: "127.0.0.1:3210",
            Origin: "http://127.0.0.1:3210",
            "Content-Type": "application/json",
            "X-ZecOne-CSRF": csrf,
            Cookie: `zecone_session=${pair.cookie}`,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () =>
            resolve({ status: res.statusCode!, data: JSON.parse(text) }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  assert.equal(
    (await post("/api/dapps/intent-quote", { id }, "wrong")).status,
    403,
  );
  assert.equal(
    (
      await post("/api/dapps/intent-quote", {
        id,
        paymentId: "private-marker",
      })
    ).status,
    400,
  );
  const preview = await post("/api/dapps/request", {
    id,
    channel: randomUUID(),
    origin,
    method: "eth_sendTransaction",
    params: f.params,
  });
  assert.equal(preview.status, 200);
  const previewConsent = await post("/api/dapps/approve", {
    id,
    reviewHash: preview.data.reviewHash,
    approved: true,
  });
  assert.equal(previewConsent.data.error.code, 4001);
  const q = await post("/api/dapps/intent-quote", { id });
  assert.equal(q.status, 200);
  assert.equal(
    (
      await post("/api/dapps/intent-quote-review", {
        id,
        quoteId: q.data.id,
        digest: q.data.digest,
        approved: true,
      })
    ).status,
    200,
  );
  const result = await post("/api/dapps/intent-checkout-preview", {
    id,
    quoteId: q.data.id,
    digest: q.data.digest,
    approved: true,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.mode, "dry-run");
  assert.equal(result.data.paymentRequestCreated, false);
  // Revoking the real disposable HTTP session while quote reads are in flight
  // must invalidate the post-read scope, not just the request's initial snapshot.
  const revokedId = randomUUID();
  const next = await post("/api/dapps/request", {
    id: revokedId,
    channel: randomUUID(),
    origin,
    method: "eth_sendTransaction",
    params: f.params,
  });
  await post("/api/dapps/approve", {
    id: revokedId,
    reviewHash: next.data.reviewHash,
    approved: true,
  });
  const oldCall = f.primary.call;
  f.primary.call = async (args: any) => {
    sessions.disconnect(pair.session);
    return oldCall(args);
  };
  assert.notEqual(
    (await post("/api/dapps/intent-quote", { id: revokedId })).status,
    200,
  );
  assert.equal(
    (
      f.ledger.db
        .prepare("SELECT COUNT(*) n FROM intent_quotes WHERE request_id=?")
        .get(revokedId) as any
    ).n,
    0,
  );
});
