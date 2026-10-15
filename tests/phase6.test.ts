import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  unifiedCheckouts,
  checkoutState,
  revealPaymentRequest,
  type CheckoutSource,
} from "../services/wallet/checkouts.ts";
import { readParams, READ_METHODS } from "../services/wallet/read-rpc.ts";
import { senderOrigin, validateRequest } from "../extension/policy.js";
import { Dapps } from "../services/wallet/dapps.ts";
import { DatabaseSync } from "node:sqlite";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { api } from "../services/wallet/api.ts";
import { Sessions } from "../services/wallet/security.ts";
const account = "0x1111111111111111111111111111111111111111";
const row: CheckoutSource = {
  id: "saved",
  status: "Awaiting payment",
  stage: "awaiting",
  expiry: 200,
  confirmations: 0,
  requiredConfirmations: 10,
};
test("payment address inspection is testnet only and refuses paid, uncertain or expired orders", () => {
  const order = {
    address: "utest1-SYNTHETIC",
    state: "awaiting_payment",
    intent: JSON.stringify({ expiry: 200, zatoshis: "100000" }),
  };
  assert.equal(revealPaymentRequest("id", order, 0n, 100).broadcast, false);
  for (const [o, received, at] of [
    [order, 1n, 100],
    [order, 0n, 201],
    [{ ...order, state: "recovery" }, 0n, 100],
    [{ ...order, address: "u1-mainnet" }, 0n, 100],
  ] as const)
    assert.throws(() => revealPaymentRequest("id", o, received, at));
});
test("unified checkout expiration never hides a paid or uncertain transaction", () => {
  assert.equal(checkoutState(row, 201), "PAYMENT_EXPIRED");
  for (const uncertain of [
    { paymentTx: "tx" },
    { stage: "sending" },
    { stage: "sent" },
    { receivedZatoshis: "1" },
  ])
    assert.equal(
      checkoutState({ ...row, ...uncertain }, 201),
      "PAYMENT_CONFIRMATIONS",
    );
  assert.equal(
    checkoutState({ ...row, baseTx: "evm" }, 201),
    "DESTINATION_EXECUTION",
  );
});
test("legacy mint expiry is distinguished from an execution failure", () => {
  assert.equal(
    checkoutState(
      {
        ...row,
        status: "Failed",
        orderState: "expired",
        recovery: "Do not pay again",
      },
      201,
    ),
    "PAYMENT_EXPIRED",
  );
  assert.equal(
    checkoutState(
      {
        ...row,
        status: "Failed",
        orderState: "failed",
        recovery: "Do not pay again",
      },
      201,
    ),
    "EXECUTION_FAILED",
  );
});
test("recovery veto takes precedence over completion and refund text never establishes a refund", () => {
  assert.equal(
    checkoutState({ ...row, status: "Completed", manualRecovery: true }, 100),
    "RECOVERY_REQUIRED",
  );
  assert.equal(
    checkoutState({ ...row, status: "REFUNDED" }, 100),
    "REFUND_AWAITING_AUTHORIZATION",
  );
});
test("projection has stable cross-adapter IDs, explicit simulated pricing and verified result distinctions", () => {
  const groups = [
    {
      kind: "swap" as const,
      rows: [{ ...row, status: "Completed", receiptVerified: false }],
    },
    {
      kind: "purchase" as const,
      rows: [{ ...row, status: "Completed", ownerVerified: true }],
    },
  ];
  const a = unifiedCheckouts(groups, account, 100),
    b = unifiedCheckouts(groups, account, 100);
  assert.deepEqual(a, b);
  assert.notEqual(a[0].key, a[1].key);
  assert.equal(a[0].resultVerified, false);
  assert.equal(a[1].resultVerified, true);
  assert.equal(a[0].liveRefundsEnabled, false);
  assert.equal(a[0].pricing, "simulated-testnet");
  assert.equal(a[0].recipient, account);
});
test("read-only RPC rejects state overrides, unknown fields, invalid addresses and excessive gas", () => {
  assert.deepEqual(readParams("eth_getBalance", [account]), [
    account,
    "latest",
  ]);
  assert.deepEqual(readParams("eth_call", [{ to: account, data: "0x" }]), [
    { to: account, data: "0x" },
    "latest",
  ]);
  for (const args of [
    [{ to: account }, "latest", {}],
    [{ to: account, nonce: "0x1" }],
    [{ to: account, gas: "0x989680" }],
    [{ to: "bad" }],
  ])
    assert.throws(() => readParams("eth_call", args));
  assert.throws(() => readParams("eth_getTransactionReceipt", ["0x01"]));
  assert.throws(() => readParams("eth_getBalance", [account, "wrong"]));
  assert.equal(READ_METHODS.includes("eth_sendRawTransaction"), false);
});
test("extension generic discovery still authenticates exact browser sender and denies frames", () => {
  for (const origin of [
    "https://app.uniswap.org",
    "https://pancakeswap.finance",
    "https://www.sushi.com",
    "https://app.aave.com",
    "https://debank.com",
    "https://zapper.xyz",
  ]) {
    const sender = {
      id: "connector",
      frameId: 0,
      tab: { id: 1 },
      documentId: "doc",
      origin,
      url: origin + "/swap",
    };
    assert.equal(senderOrigin(sender, "connector"), origin);
    assert.throws(() =>
      senderOrigin({ ...sender, origin: "https://evil.example" }, "connector"),
    );
    assert.throws(() => senderOrigin({ ...sender, frameId: 1 }, "connector"));
  }
});
test("generic read requests cannot bypass extension transaction and raw-signing restrictions", () => {
  for (const method of READ_METHODS)
    assert.doesNotThrow(() =>
      validateRequest({
        kind: "request",
        id: randomUUID(),
        method,
        params: [],
      }),
    );
  for (const method of [
    "eth_sign",
    "eth_sendRawTransaction",
    "zecone_payWithZec",
  ])
    assert.throws(
      () =>
        validateRequest({
          kind: "request",
          id: randomUUID(),
          method,
          params: [],
        }),
      { code: 4200 },
    );
  assert.throws(
    () =>
      validateRequest({
        kind: "request",
        id: randomUUID(),
        method: "eth_sendTransaction",
        params: [{ chainId: "0x1" }],
      }),
    { code: 4901 },
  );
});
test("RPC reads require a grant and use the selected configured chain, without invoking a signer", async () => {
  const d = new Dapps(account, ":memory:");
  const session = {
    id: "phase6",
    csrf: "test",
    expires: Date.now() + 60000,
    connected: 1,
  };
  const base = {
    channel: randomUUID(),
    origin: "https://new-dapp.example",
    method: "eth_getBalance",
    params: [account],
  };
  try {
    await assert.rejects(d.request(session, { ...base, id: randomUUID() }), {
      code: 4100,
    });
    d.db
      .prepare("INSERT INTO permissions VALUES(?,?)")
      .run(base.origin, Date.now());
    let reads = 0;
    (d as any).client = () => ({
      getChainId: async () => 84532,
      request: async (v: any) => {
        reads++;
        assert.equal(v.method, "eth_getBalance");
        return "0x2";
      },
    });
    assert.deepEqual(await d.request(session, { ...base, id: randomUUID() }), {
      done: true,
      result: "0x2",
    });
    assert.equal(reads, 1);
    (d as any).client = () => ({ getChainId: async () => 1 });
    await assert.rejects(d.request(session, { ...base, id: randomUUID() }), {
      code: 4901,
    });
    assert.equal(
      d.db.prepare("SELECT count(*) AS n FROM requests").get()?.n,
      0,
    );
  } finally {
    d.db.close();
  }
});
test("unified HTTP endpoint requires local account verification and projects every existing adapter without mutations", async () => {
  const db = new DatabaseSync(":memory:"),
    sessions = new Sessions(db),
    pair = sessions.pair(sessions.issuePairing());
  let writes = 0;
  const engine = {
    dashboard: () => ({
      address: account,
      checkouts: [{ ...row, kind: "mint" }],
    }),
    pay: () => writes++,
  } as any;
  const source = { list: () => [{ ...row, recipient: account }] } as any;
  const server = createServer(
    api(sessions, engine, undefined, source, source, source),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const get = (cookie?: string) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const r = request(
        {
          host: "127.0.0.1",
          port: (server.address() as any).port,
          path: "/api/checkouts",
          headers: {
            Host: "127.0.0.1:3210",
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () =>
            resolve({ status: res.statusCode!, body: JSON.parse(b) }),
          );
        },
      );
      r.on("error", reject);
      r.end();
    });
  try {
    assert.equal((await get()).status, 401);
    const cookie = `zecone_session=${pair.cookie}`;
    assert.equal((await get(cookie)).status, 403);
    db.prepare("UPDATE sessions SET connected=1 WHERE id=?").run(
      pair.session.id,
    );
    const a = await get(cookie),
      b = await get(cookie);
    assert.equal(a.status, 200);
    assert.deepEqual(a, b);
    assert.equal(a.body.checkouts.length, 4);
    assert.equal(writes, 0);
  } finally {
    server.close();
    await once(server, "close");
    db.close();
  }
});
