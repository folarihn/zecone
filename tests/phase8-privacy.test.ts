// Disposable, synthetic fixtures only. No historical credential or live RPC use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { blockhash, getBase58Decoder } from "@solana/kit";
import { Sessions, ApiError } from "../services/wallet/security.ts";
import {
  CheckoutScopes,
  checkoutBrowserView,
  dashboardBrowserView,
  listingBrowserView,
  PrivacyDiagnostics,
  privacyError,
  INSPECTION_WARNING,
} from "../services/wallet/privacy.ts";
import {
  swapBrowserView,
  deliveryBrowserView,
} from "../services/solana/privacy.ts";
import { snapshotApi } from "../services/wallet/snapshot-api.ts";
import { settlementApi } from "../services/solana/settlement-api.ts";
import { swapApi } from "../services/solana/swap-api.ts";
import { api } from "../services/wallet/api.ts";
import { Store } from "../services/execution/store.ts";
import { SolanaSettlement } from "../services/solana/settlement.ts";
import {
  CpmmPolicy,
  CPMM,
  POOL,
  WSOL,
  OUTPUT,
  PROGRAM_HASH,
  quoteOutput,
} from "../services/solana/cpmm.ts";
import { GENESIS, Devnet } from "../services/solana/network.ts";
import { restoreSelection } from "../app/checkout/selection.ts";

const CANARY = "PRIVATE_PAYMENT_CANARY_NOT_REAL",
  recipient = "11111111111111111111111111111111",
  relayer = getBase58Decoder().decode(new Uint8Array(32).fill(7));
const makeSession = (id = "one", expires = 200) => ({
  id,
  expires,
  csrf: "fixture",
  connected: 1,
});
const row: any = {
  key: "mint:internal",
  id: "internal",
  kind: "mint",
  state: "COMPLETED",
  status: "Completed",
  stage: "sent",
  chainId: 84532,
  networkName: "Base Sepolia",
  recipient,
  zatoshis: "100000",
  expiry: 200,
  confirmations: 10,
  requiredConfirmations: 10,
  paymentTx: CANARY,
  paymentAddress: CANARY,
  wire: CANARY,
  order_id: CANARY,
  fee: { feeZatoshis: "10000", totalZatoshis: "110000", seed: CANARY },
  resultVerified: true,
};
async function serve(handler: any) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
    call: (
      path: string,
      who?: any,
      body?: unknown,
      extra: Record<string, string> = {},
    ) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: (server.address() as any).port,
            path,
            method: body === undefined ? "GET" : "POST",
            headers: {
              Host: "127.0.0.1:3210",
              Origin: "http://127.0.0.1:3210",
              "Content-Type": "application/json",
              ...(who
                ? {
                    Cookie: `zecone_session=${who.cookie}`,
                    "X-ZecOne-CSRF": who.session.csrf,
                  }
                : {}),
              ...extra,
            },
          },
          (res) => {
            let raw = "";
            res.on("data", (x) => (raw += x));
            res.on("end", () =>
              resolve({ status: res.statusCode!, body: JSON.parse(raw) }),
            );
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      }),
  };
}
function users(sessions: Sessions) {
  const a = sessions.pair(sessions.issuePairing()),
    b = sessions.pair(sessions.issuePairing());
  sessions.db.exec("UPDATE sessions SET connected=1");
  return { a, b };
}

test("Phase 8A response projections drop nested secrets and backend joins", () => {
  const v = {
    ...row,
    network: "solana:devnet",
    prepared: { fee: "5000", wire: CANARY },
    swap: {
      amountIn: "1000000",
      minimumOut: "75000000",
      privateEvidence: CANARY,
    },
    paymentTxs: [CANARY],
    profileId: CANARY,
  };
  for (const result of [
    checkoutBrowserView(row, "opaque"),
    listingBrowserView(row, "opaque"),
    swapBrowserView(v, "opaque"),
    deliveryBrowserView(v, "opaque"),
    dashboardBrowserView(
      { checkouts: [row], zcash: { history: [{ txid: CANARY }] }, ...row },
      () => "opaque",
    ),
  ]) {
    assert.ok(!JSON.stringify(result).includes(CANARY));
    assert.ok(!JSON.stringify(result).includes("internal"));
  }
  assert.deepEqual(
    Object.keys(checkoutBrowserView(row, "opaque")).sort(),
    [
      "key",
      "id",
      "kind",
      "state",
      "status",
      "stage",
      "chainId",
      "networkName",
      "recipient",
      "zatoshis",
      "expiry",
      "confirmations",
      "requiredConfirmations",
      "paymentTx",
      "paymentAddress",
      "destinationTx",
      "asset",
      "tokenId",
      "minOut",
      "slippageBps",
      "fee",
      "recovery",
      "resultVerified",
      "pricing",
      "settlement",
      "liveRefundsEnabled",
    ].sort(),
  );
});
test("Phase 8A handles expire, rotate after restart and cannot cross sessions or adapters", () => {
  let now = 100;
  const scopes = new CheckoutScopes(() => now),
    a = makeSession(),
    b = makeSession("two");
  const h = scopes.handle(a, "mint", "financial-id");
  assert.equal(scopes.handle(a, "mint", "financial-id"), h);
  assert.throws(() => scopes.resolve(b, h, "mint"));
  assert.throws(() => scopes.resolve(a, h, "swap"));
  assert.throws(() => new CheckoutScopes(() => now).resolve(a, h, "mint"));
  scopes.forget(a);
  assert.throws(() => scopes.resolve(a, h, "mint"));
  const h2 = scopes.handle(a, "mint", "financial-id");
  assert.notEqual(h, h2);
  now = 200;
  assert.throws(() => scopes.resolve(a, h2, "mint"));
});
test("Phase 8A browser selection is bounded to scope, expiry and current visible handles", () => {
  const raw = JSON.stringify({ scope: "one", expires: 200, key: "opaque" });
  assert.equal(restoreSelection(raw, "one", 200, ["opaque"], 100), "opaque");
  for (const args of [
    ["two", 200, ["opaque"], 100],
    ["one", 201, ["opaque"], 100],
    ["one", 200, [], 100],
    ["one", 200, ["opaque"], 200],
  ] as const)
    assert.equal(
      restoreSelection(raw, args[0], args[1], [...args[2]], args[3]),
      "",
    );
  assert.equal(restoreSelection("invalid", "one", 200, [], 100), "");
  const ui = readFileSync("app/checkout/tracker.tsx", "utf8");
  assert.ok(!ui.includes("localStorage.setItem"));
  assert.match(ui, /localStorage.removeItem/);
  assert.match(ui, /r.status === 401/);
});
test("Phase 8A session retention prunes only expired authentication rows", () => {
  let now = 100;
  const db = new DatabaseSync(":memory:"),
    sessions = new Sessions(db, () => now);
  const a = sessions.pair(sessions.issuePairing());
  db.exec(
    "CREATE TABLE immutable_financial(id TEXT PRIMARY KEY,signature TEXT); INSERT INTO immutable_financial VALUES('order','saved-signature');",
  );
  now = a.session.expires;
  assert.throws(() => sessions.get(`zecone_session=${a.cookie}`));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 0);
  assert.equal(
    db.prepare("SELECT signature FROM immutable_financial").get()!.signature,
    "saved-signature",
  );
  db.close();
});
test("Phase 8A display aliases preserve exact approval references and redact server exceptions", async () => {
  const db = new DatabaseSync(":memory:"),
    s = new Sessions(db),
    { a } = users(s),
    id = randomUUID(),
    quoteId = randomUUID();
  let fail = false;
  const seen: any[] = [];
  const engine: any = {
    dashboard: () => {
      if (fail) throw Error(CANARY);
      return {
        checkouts: [
          {
            ...row,
            id,
            quote: {
              id: quoteId,
              feeZatoshis: "1",
              totalZatoshis: "2",
              expires: 200,
            },
          },
        ],
      };
    },
    pay: (_s: any, checkout: string, quote: string, approved: unknown) => {
      seen.push({ checkout, quote, approved });
      return { fixture: true };
    },
  };
  const http = await serve(api(s, engine));
  try {
    const c = (await http.call("/api/dashboard", a)).body.checkouts[0];
    assert.notEqual(c.id, id);
    assert.notEqual(c.quote.id, quoteId);
    const r = await http.call("/api/pay", a, {
      id: c.id,
      quoteId: c.quote.id,
      approved: false,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(seen, [{ checkout: id, quote: quoteId, approved: false }]);
    fail = true;
    const error = await http.call("/api/dashboard", a);
    assert.equal(error.status, 503);
    assert.ok(!JSON.stringify(error.body).includes(CANARY));
    assert.ok(
      !JSON.stringify(
        (await http.call("/api/privacy/diagnostics", a)).body,
      ).includes(CANARY),
    );
  } finally {
    await http.close();
    db.close();
  }
});
test("Phase 8A diagnostics accept only finite codes and export counts with bounded retention", () => {
  let now = 100;
  const d = new PrivacyDiagnostics(() => now);
  for (let i = 0; i < 110; i++)
    d.record("INVALID_REQUEST", {
      error: CANARY,
      url: `https://fixture.invalid/${CANARY}`,
      privateKey: CANARY,
    });
  assert.equal(
    d.export().counts.find((x) => x.code === "INVALID_REQUEST")!.count,
    100,
  );
  assert.ok(!JSON.stringify(d.export()).includes(CANARY));
  assert.throws(() => d.record(CANARY as any));
  now += 86400000;
  assert.ok(d.export().counts.every((x) => x.count === 0));
  for (const e of [
    new Error(CANARY),
    new ApiError(403, CANARY),
    { code: CANARY },
  ])
    assert.ok(!JSON.stringify(privacyError(e)).includes(CANARY));
});
test("Phase 8A snapshot private inspection requires local session, CSRF, acknowledgement and scoped handle", async () => {
  const db = new DatabaseSync(":memory:"),
    s = new Sessions(db),
    { a, b } = users(s);
  const snapshot = {
    dashboard: {
      address: recipient,
      checkouts: [row],
      zcash: { history: [{ txid: CANARY }] },
    },
    checkouts: [row],
    networks: [],
    lists: { purchase: [], swap: [], seaport: [] },
  };
  const http = await serve(snapshotApi(s, snapshot));
  try {
    assert.equal((await http.call("/api/checkouts")).status, 401);
    const list = await http.call("/api/checkouts", a),
      handle = list.body.checkouts[0].id;
    assert.ok(!JSON.stringify(list.body).includes(CANARY));
    assert.notEqual(handle, row.id);
    assert.ok(
      !JSON.stringify((await http.call("/api/dashboard", a)).body).includes(
        CANARY,
      ),
    );
    const body = {
      id: handle,
      kind: "mint",
      reveal: true,
      acceptPrivacy: true,
    };
    assert.equal(
      (await http.call("/api/checkouts/inspect", b, body)).status,
      404,
    );
    assert.equal(
      (
        await http.call("/api/checkouts/inspect", a, body, {
          "X-ZecOne-CSRF": "wrong",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await http.call("/api/checkouts/inspect", a, {
          ...body,
          acceptPrivacy: false,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await http.call("/api/checkouts/inspect", a, body, {
          Origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    const revealed = await http.call("/api/checkouts/inspect", a, body);
    assert.equal(revealed.body.paymentTx, CANARY);
    assert.equal(revealed.body.privacy, INSPECTION_WARNING);
    assert.equal(snapshot.checkouts[0].paymentTx, CANARY);
    s.disconnect(a.session);
    assert.equal(
      (await http.call("/api/checkouts/inspect", a, body)).status,
      401,
    );
  } finally {
    await http.close();
    db.close();
  }
});
test("Phase 8A EVM inspection rechecks backend owner rather than treating a handle as authority", async () => {
  const db = new DatabaseSync(":memory:"),
    s = new Sessions(db),
    { a, b } = users(s);
  const id = randomUUID();
  let revealCalls = 0;
  const engine: any = {
    dashboard: () => ({ address: recipient, checkouts: [{ ...row, id }] }),
    app: { get: () => ({ quote_session: a.session.id }) },
    paymentRequest: () => {
      revealCalls++;
      return { id, address: "utest1_fixture", zatoshis: "1", expiry: 200 };
    },
  };
  const http = await serve(api(s, engine));
  try {
    const own = await http.call("/api/checkouts", a),
      other = await http.call("/api/checkouts", b);
    const body = { id: own.body.checkouts[0].id, kind: "mint", reveal: true };
    assert.equal(
      (await http.call("/api/checkouts/payment-request", b, body)).status,
      404,
    );
    assert.equal(
      (
        await http.call("/api/checkouts/payment-request", b, {
          ...body,
          id: other.body.checkouts[0].id,
        })
      ).status,
      403,
    );
    const r = await http.call("/api/checkouts/payment-request", a, body);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, undefined);
    assert.equal(r.body.privacy, INSPECTION_WARNING);
    assert.equal(revealCalls, 1);
  } finally {
    await http.close();
    db.close();
  }
});

function solanaFixture() {
  const store = new Store(":memory:"),
    sessions = new Sessions(store.db),
    { a, b } = users(sessions);
  const network: any = new Proxy(
    {},
    {
      get: () => () => {
        throw Error("No fixture network/signing permitted");
      },
    },
  );
  const service = new SolanaSettlement(store, network, () => 100);
  const profile = {
    id: randomUUID(),
    orderId: randomUUID(),
    recipient,
    relayer,
  };
  const manifest = { keyId: "a".repeat(64), address: "utest1_SYNTHETIC_ONLY" };
  return { store, sessions, a, b, network, service, profile, manifest };
}
test("Phase 8A delivery status and inspection are owner-scoped; persisted evidence stays private", async () => {
  const x = solanaFixture(),
    http = await serve(
      settlementApi(x.sessions, x.service, x.profile, x.manifest),
    );
  try {
    const quote = await http.call("/api/solana-settlement/quote", x.a, {
      recipient,
      lamports: "1000000",
    });
    assert.equal(quote.status, 200);
    const id = x.store.all()[0].id;
    x.store.db
      .prepare("INSERT INTO payments VALUES(?,?,?,?,?,?,?)")
      .run(CANARY, id, "100000", 1, "fixture", 1, 1);
    const list = await http.call("/api/checkouts", x.a);
    assert.ok(!JSON.stringify(list.body).includes(CANARY));
    assert.ok(!JSON.stringify(list.body).includes(id));
    assert.deepEqual(
      (await http.call("/api/solana-settlement/status", x.b)).body.orders,
      [],
    );
    assert.equal(
      (
        await http.call("/api/solana-settlement/quote", x.b, {
          recipient,
          lamports: "1000000",
        })
      ).status,
      403,
    );
    const body = {
      id: list.body.checkouts[0].id,
      kind: "solana",
      reveal: true,
      acceptPrivacy: true,
    };
    assert.equal(
      (await http.call("/api/checkouts/inspect", x.b, body)).status,
      404,
    );
    assert.equal(
      (await http.call("/api/checkouts/inspect", x.a, body)).body.paymentTx,
      CANARY,
    );
    assert.equal(
      x.store.db.prepare("SELECT key FROM payments").get()!.key,
      CANARY,
    );
    // Synthetic completed fixture: policy must veto before accessing any signer.
    x.store.db.prepare("UPDATE orders SET state='settled'").run();
    x.store.db
      .prepare("UPDATE solana_settlement SET state='COMPLETED',claimed=1")
      .run();
    await assert.rejects(x.service.prepare(id));
    const poison: any = new Proxy(
      {},
      {
        get() {
          assert.fail("Signer must not be accessed");
        },
      },
    );
    await assert.rejects(
      x.service.execute(
        id,
        { orderId: id, digest: "unapproved", approved: true },
        poison,
      ),
    );
  } finally {
    await http.close();
    x.store.close();
  }
});
test("Phase 8A existing swap without attached history cannot be claimed by a new browser", async () => {
  const x = solanaFixture(),
    policy = new CpmmPolicy(x.network, () => 100);
  const liquidity = {
    reserveIn: 800000000n,
    reserveOut: 60000000000n,
    feeRate: 2500n,
  };
  policy.pool = async () => liquidity;
  const terms = await policy.terms();
  const service = new SolanaSettlement(x.store, x.network, () => 100, policy);
  service.quote(
    {
      profileId: x.profile.id,
      requestId: x.profile.orderId,
      recipient,
      relayer,
      lamports: "1000000",
      account: x.manifest.keyId,
      paymentAddress: x.manifest.address,
    },
    terms,
  );
  const http = await serve(
    swapApi(x.sessions, service, policy, x.profile, x.manifest),
  );
  try {
    assert.equal(
      (await http.call("/api/solana-swap/quote", x.a, { recipient })).status,
      403,
    );
    assert.equal(x.store.all().length, 1);
  } finally {
    await http.close();
    x.store.close();
  }
});
test("Phase 8A actual unsigned swap construction passes no shielded metadata to destination calls", async () => {
  const requests: any[] = [];
  const record = (name: string, value: any, result: any) => {
    requests.push({ name, value });
    return Promise.resolve(result);
  };
  const network: any = {
    latest: () =>
      record("latest", null, {
        blockhash: blockhash("11111111111111111111111111111111"),
        lastValidBlockHeight: 1000n,
      }),
    fee: (v: any) => record("fee", v, 5000n),
    valid: (v: any) => record("valid", v, true),
    simulate: (v: any) =>
      record("simulate", v, { err: null, unitsConsumed: 100n }),
  };
  const policy = new CpmmPolicy(network, () => 100),
    liquidity = {
      reserveIn: 800000000n,
      reserveOut: 60000000000n,
      feeRate: 2500n,
    };
  policy.pool = async () => {
    requests.push({ name: "pool", value: POOL });
    return liquidity;
  };
  policy.accounts = async () => {};
  const expected = quoteOutput(liquidity),
    terms: any = {
      program: CPMM,
      pool: POOL,
      inputMint: WSOL,
      outputMint: OUTPUT,
      inputDecimals: 9,
      outputDecimals: 6,
      amountIn: "1000000",
      slippageBps: 100,
      expectedOut: String(expected),
      minimumOut: String((expected * 9900n) / 10000n),
      programHash: PROGRAM_HASH,
    };
  const intent: any = {
    family: "solana",
    action: "SOLANA_DEVNET_SPL_SWAP",
    network: "solana:devnet",
    genesis: GENESIS,
    recipient,
    relayer,
    lamports: "1000000",
    feeCap: "10000",
    zatoshis: "100000",
    nonce: "0x" + "a".repeat(64),
    expiry: 1000,
    swap: terms,
    profileId: CANARY,
    requestId: CANARY,
    paymentTx: CANARY,
  };
  const prepared = await policy.prepare(intent);
  assert.ok(prepared.wire);
  assert.ok(requests.some((r) => r.name === "simulate"));
  const serialized = JSON.stringify(requests);
  assert.ok(!serialized.includes(CANARY));
  for (const r of requests.filter((r) => ["fee", "simulate"].includes(r.name)))
    assert.ok(!Buffer.from(r.value, "base64").includes(Buffer.from(CANARY)));
  // Pool validation requests also have a fixed public-account allowlist.
  const calls: any[] = [];
  const fake: any = {
    getGenesisHash: () => ({ send: async () => GENESIS }),
    getMultipleAccounts: (...args: any[]) => {
      calls.push(args);
      return { send: async () => ({ context: { slot: 1n }, value: [null] }) };
    },
  };
  const net = new Devnet(fake, 1000, undefined, 0);
  await net.consistentAccounts([POOL], false);
  assert.ok(
    !JSON.stringify(calls, (_, v) =>
      typeof v === "bigint" ? String(v) : v,
    ).includes(CANARY),
  );
});
