// Synthetic fixtures; real external evidence lives separately in docs/phase4d-evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { Sessions, ORIGIN } from "../services/wallet/security.ts";
import { api as walletApi } from "../services/wallet/api.ts";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  zeroAddress,
  zeroHash,
  hashStruct,
  toFunctionSignature,
  getAddress,
  type Address,
} from "viem";
import {
  OpenSeaReadApi,
  safeJson,
  limitedText,
} from "../services/opensea/api.ts";
import {
  normalize,
  parseListing,
  checkedFulfillment,
  CONDUIT_KEY,
  integer,
} from "../services/opensea/inspection.ts";
import {
  assertFreshPreview,
  safeImage,
  collectionFees,
} from "../services/opensea/service.ts";
import {
  PROTOCOL,
  seaportAbi,
  components,
  orderTypes,
} from "../services/seaport/protocol.ts";
const recipient = getAddress("0x1111111111111111111111111111111111111111"),
  seller = privateKeyToAccount(generatePrivateKey());
const now = Math.floor(Date.now() / 1000);
function listing() {
  const parameters = {
    offerer: seller.address,
    zone: zeroAddress,
    offer: [
      {
        itemType: 2,
        token: recipient,
        identifierOrCriteria: "42",
        startAmount: "1",
        endAmount: "1",
      },
    ],
    consideration: [
      {
        itemType: 0,
        token: zeroAddress,
        identifierOrCriteria: "0",
        startAmount: "990000000000000",
        endAmount: "990000000000000",
        recipient: seller.address,
      },
      {
        itemType: 0,
        token: zeroAddress,
        identifierOrCriteria: "0",
        startAmount: "10000000000000",
        endAmount: "10000000000000",
        recipient,
      },
    ],
    orderType: 0,
    startTime: String(now - 60),
    endTime: String(now + 3600),
    zoneHash: zeroHash,
    salt: "0x01",
    conduitKey: CONDUIT_KEY,
    counter: "0",
    totalOriginalConsiderationItems: 2,
  };
  const p = normalize(parameters);
  return {
    chain: "ethereum",
    status: "ACTIVE",
    remaining_quantity: 1,
    protocol_address: PROTOCOL,
    order_hash: hashStruct({
      types: orderTypes,
      primaryType: "OrderComponents",
      data: components(p),
    }),
    protocol_data: { parameters, signature: null },
    asset: { contract: recipient, identifier: "42" },
    price: {
      current: { currency: "ETH", decimals: 18, value: "1000000000000000" },
    },
  };
}
async function fulfillment(raw = listing()) {
  const l = parseListing(raw),
    signature = await seller.signTypedData({
      domain: {
        name: "Seaport",
        version: "1.6",
        chainId: 1,
        verifyingContract: PROTOCOL,
      },
      types: orderTypes,
      primaryType: "OrderComponents",
      message: components(l.p),
    });
  const { counter, ...p } = components(l.p);
  const parameters = { ...p, totalOriginalConsiderationItems: 2n };
  const advancedOrder = {
    parameters,
    numerator: 1n,
    denominator: 1n,
    signature,
    extraData: "0x",
  };
  return {
    protocol: "seaport1.6",
    fulfillment_data: {
      orders: [{ parameters: raw.protocol_data.parameters, signature }],
      transaction: {
        chain: 1,
        to: PROTOCOL,
        value: String(l.total),
        calldata_suffix: "0xcdb44011",
        function: toFunctionSignature(
          seaportAbi.find(
            (v) => v.type === "function" && v.name === "fulfillAdvancedOrder",
          )! as any,
        ),
        input_data: {
          advancedOrder,
          criteriaResolvers: [],
          fulfillerConduitKey: CONDUIT_KEY,
          recipient,
        },
      },
    },
  };
}
test("OpenSea normalizes exact hex salt and uint256 values without float coercion", () => {
  assert.equal(integer("0xff"), "255");
  assert.throws(() => integer(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => integer("1.1"));
  assert.throws(() => integer("-1"));
  assert.throws(() => integer(String(2n ** 256n)));
  assert.equal(parseListing(listing()).total, 1000000000000000n);
});
for (const [name, mutate] of [
  ["wrong chain", (r: any) => (r.chain = "base")],
  ["wrong protocol", (r: any) => (r.protocol_address = recipient)],
  [
    "expired listing",
    (r: any) => (r.protocol_data.parameters.endTime = String(now - 1)),
  ],
  ["restricted order", (r: any) => (r.protocol_data.parameters.orderType = 2)],
  [
    "unknown conduit",
    (r: any) =>
      (r.protocol_data.parameters.conduitKey = "0x" + "12".repeat(32)),
  ],
  [
    "criteria NFT",
    (r: any) => (r.protocol_data.parameters.offer[0].itemType = 4),
  ],
  [
    "dynamic price",
    (r: any) => (r.protocol_data.parameters.consideration[0].endAmount = "1"),
  ],
  [
    "changed consideration",
    (r: any) =>
      (r.protocol_data.parameters.consideration[0].recipient = recipient),
  ],
  [
    "extra tip",
    (r: any) =>
      (r.protocol_data.parameters.totalOriginalConsiderationItems = 1),
  ],
  ["wrong NFT", (r: any) => (r.asset.identifier = "43")],
  ["wrong price", (r: any) => (r.price.current.value = "1")],
  ["wrong hash", (r: any) => (r.order_hash = zeroHash)],
] as const)
  test(`OpenSea rejects ${name}`, () => {
    const r = listing();
    mutate(r);
    assert.throws(() => parseListing(r));
  });
test("OpenSea reconstructs genuine-format advanced fulfillment including bounded attribution", async () => {
  const raw = listing(),
    f = await fulfillment(raw);
  const checked = checkedFulfillment(f, parseListing(raw), recipient);
  assert.ok(checked.data.endsWith("cdb44011"));
  assert.equal(checked.suffix, "0xcdb44011");
});
for (const [name, mutate] of [
  [
    "recipient substitution",
    (f: any) =>
      (f.fulfillment_data.transaction.input_data.recipient = zeroAddress),
  ],
  ["wrong chain", (f: any) => (f.fulfillment_data.transaction.chain = 84532)],
  [
    "changed fee",
    (f: any) =>
      (f.fulfillment_data.transaction.input_data.advancedOrder.parameters.consideration[1].startAmount =
        99n),
  ],
  [
    "partial fill",
    (f: any) =>
      (f.fulfillment_data.transaction.input_data.advancedOrder.denominator =
        2n),
  ],
  [
    "zone extra data",
    (f: any) =>
      (f.fulfillment_data.transaction.input_data.advancedOrder.extraData =
        "0x01"),
  ],
  [
    "unbounded suffix",
    (f: any) =>
      (f.fulfillment_data.transaction.calldata_suffix = "0x" + "ff".repeat(32)),
  ],
  [
    "order signature substitution",
    (f: any) =>
      (f.fulfillment_data.orders[0].signature = "0x" + "00".repeat(65)),
  ],
  [
    "API value mismatch",
    (f: any) => (f.fulfillment_data.transaction.value = "0"),
  ],
] as const)
  test(`OpenSea fulfillment rejects ${name}`, async () => {
    const r = listing(),
      f = await fulfillment(r);
    mutate(f);
    assert.throws(() => checkedFulfillment(f, parseListing(r), recipient));
  });
const auth = { key: "SYNTHETIC-API-KEY", expires: Date.now() + 60000 };
test("OpenSea credential is server-only, constrained to official origin and safe paths", async () => {
  let calls = 0;
  const api = new OpenSeaReadApi(
    (async (url, init) => {
      calls++;
      assert.equal(url, "https://api.opensea.io/api/v2/chains");
      assert.equal((init!.headers as any)["x-api-key"], auth.key);
      assert.equal(init!.redirect, "error");
      return Response.json({ chains: [{ chain: "ethereum" }] });
    }) as typeof fetch,
    auth,
  );
  assert.deepEqual(await api.supported(), ["ethereum"]);
  await api.supported();
  assert.equal(calls, 1);
  await assert.rejects(api.read("https://evil.example/"));
  await assert.rejects(api.read("/api/v2/auth/keys", {}));
  assert.equal(calls, 1);
  assert.ok(
    !JSON.stringify(await api.read("/api/v2/chains")).includes(auth.key),
  );
});
test("OpenSea expired credentials fail before network access", async () => {
  const api = new OpenSeaReadApi(
    (async () => {
      throw Error("should not call");
    }) as typeof fetch,
    { key: "fixture", expires: 0 },
  );
  await assert.rejects(api.supported(), /expired/);
});
test("OpenSea 429 retry window prevents repeat calls", async () => {
  let calls = 0;
  const api = new OpenSeaReadApi(
    (async () => {
      calls++;
      return new Response("", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }) as typeof fetch,
    auth,
  );
  await assert.rejects(api.supported(), /rate limited/);
  await assert.rejects(api.supported(), /rate limited/);
  assert.equal(calls, 1);
});
test("OpenSea errors never relay upstream bodies or secret-bearing exceptions", async () => {
  for (const status of [401, 403, 500]) {
    const api = new OpenSeaReadApi(
      (async () => new Response(auth.key, { status })) as typeof fetch,
      auth,
    );
    await assert.rejects(
      api.supported(),
      (e: any) => !e.message.includes(auth.key),
    );
  }
  const api = new OpenSeaReadApi(
    (async () => {
      throw Error(auth.key);
    }) as typeof fetch,
    auth,
  );
  await assert.rejects(
    api.supported(),
    (e: any) => !e.message.includes(auth.key),
  );
});
test("OpenSea validates response size and unsafe numeric data", async () => {
  assert.throws(() => safeJson('{"price":9007199254740993}'));
  await assert.rejects(limitedText(new Response("x".repeat(100)), 10));
  const api = new OpenSeaReadApi(
    (async () => Response.json({ listings: {} })) as typeof fetch,
    auth,
  );
  await assert.rejects(api.supported());
});
test("Read-only quote rejects expiry, recipient/hash substitution and executable state", () => {
  const p = {
    expiry: now + 100,
    recipient,
    orderHash: zeroHash,
    executable: false,
  };
  assertFreshPreview(p, recipient, zeroHash, now);
  for (const changed of [
    { expiry: now },
    { recipient: zeroAddress },
    { orderHash: "other" },
    { executable: true },
  ])
    assert.throws(() =>
      assertFreshPreview({ ...p, ...changed }, recipient, zeroHash, now),
    );
});
test("NFT image fetch refuses arbitrary hosts, loopback, non-HTTPS and SVG URLs", async () => {
  for (const v of [
    "http://127.0.0.1/seed",
    "https://evil.example/a",
    "data:image/svg+xml,script",
    "https://i.seadn.io.evil.example/a",
    "https://user:pass@i.seadn.io/a",
  ]) {
    assert.equal(await safeImage(v), null);
  }
});
function extension(origin = "https://opensea.io") {
  const handlers = new Map<string, Function[]>(),
    announcements: any[] = [],
    sent: any[] = [],
    timers: Function[] = [],
    popup = {
      closed: false,
      close() {
        this.closed = true;
      },
      postMessage(m: any, target: string) {
        sent.push({ m, target });
      },
    };
  const win: any = {
    addEventListener(k: string, f: Function) {
      handlers.set(k, [...(handlers.get(k) || []), f]);
    },
    dispatchEvent(e: any) {
      if (e.type === "eip6963:announceProvider") announcements.push(e.detail);
      for (const f of handlers.get(e.type) || []) f(e);
    },
    open() {
      return popup;
    },
  };
  win.top = win;
  runInNewContext(readFileSync("extension/provider.js", "utf8"), {
    window: win,
    location: { origin },
    crypto: { randomUUID },
    CustomEvent: class {
      constructor(
        public type: string,
        public options: any,
      ) {
        Object.assign(this, options);
      }
    },
    setInterval: () => 0,
    setTimeout: (f: Function) => {
      timers.push(f);
      return timers.length;
    },
    clearTimeout: () => {},
    Map,
    Set,
    Error,
  });
  const receive = (
    m: any,
    from = "http://127.0.0.1:3210",
    source: any = popup,
  ) => win.dispatchEvent({ type: "message", origin: from, source, data: m });
  return {
    provider: announcements[0]?.provider,
    win,
    popup,
    receive,
    sent,
    announcements,
    timers,
  };
}
test("Extension EIP-6963 discovery is frozen and restricted to exact top-level OpenSea origins", () => {
  const e = extension();
  assert.equal(e.announcements[0].info.name, "ZecOne Testnet");
  assert.ok(Object.isFrozen(e.provider));
  e.win.dispatchEvent({ type: "eip6963:requestProvider" });
  assert.equal(e.announcements.length, 2);
  assert.equal(
    extension("https://opensea.io.evil.example").provider,
    undefined,
  );
  const m = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.permissions, undefined);
  assert.deepEqual(m.background, { service_worker: "background.js", type: "module" });
  assert.equal(m.externally_connectable, undefined);
});
test("Extension rejects unauthorized signing and private wallet RPC without opening a signer", async () => {
  const e = extension();
  await assert.rejects(
    e.provider.request({ method: "personal_sign", params: [] }),
    { code: 4100 },
  );
  for (const method of [
    "zcash_getBalance",
    "zcash_getViewingKey",
    "eth_sign",
    "wallet_export",
    "eth_sendRawTransaction",
  ]) {
    await assert.rejects(e.provider.request({ method }), { code: 4200 });
  }
  assert.equal(e.sent.length, 0);
  assert.deepEqual(
    Array.from(await e.provider.request({ method: "eth_accounts" })),
    [],
  );
});
test("Extension authenticates popup source/origin/channel and correlates responses", async () => {
  const e = extension(),
    promise = e.provider.request({ method: "eth_requestAccounts" });
  const channel = e.sent[0].m.channel;
  for (const [origin, source, c] of [
    ["https://evil.example", e.popup, channel],
    ["http://127.0.0.1:3210", {}, channel],
    ["http://127.0.0.1:3210", e.popup, "forged"],
  ] as any[])
    e.receive(
      {
        protocol: "zecone:2",
        kind: "ready",
        chain: c,
        channel: c,
        chainId: "0x14a34",
      },
      origin,
      source,
    );
  assert.equal(e.sent.length, 1);
  e.receive({
    protocol: "zecone:2",
    kind: "ready",
    channel,
    chainId: "0x14a34",
  });
  assert.equal(e.sent.length, 2);
  const id = e.sent[1].m.id;
  e.receive({
    protocol: "zecone:2",
    kind: "response",
    channel,
    id: "wrong",
    result: [zeroAddress],
  });
  e.receive({
    protocol: "zecone:2",
    kind: "response",
    channel,
    id,
    result: [recipient],
  });
  assert.deepEqual(await promise, [recipient]);
  e.receive({
    protocol: "zecone:2",
    kind: "response",
    channel,
    id,
    result: [zeroAddress],
  });
  assert.equal(e.sent.length, 2);
});
test("Extension revocation/session expiry rejects pending requests and disconnects", async () => {
  const e = extension(),
    promise = e.provider.request({ method: "eth_requestAccounts" }),
    channel = e.sent[0].m.channel;
  e.receive({
    protocol: "zecone:2",
    kind: "event",
    channel,
    event: "disconnect",
  });
  await assert.rejects(promise, { code: 4900 });
  assert.equal(e.popup.closed, true);
});
test("Extension malformed and oversized requests fail; request timeout does not retry", async () => {
  const e = extension();
  await assert.rejects(
    e.provider.request({ method: "eth_requestAccounts", origin: "forged" }),
    { code: -32602 },
  );
  await assert.rejects(
    e.provider.request({
      method: "personal_sign",
      params: ["x".repeat(16001)],
    }),
    { code: -32602 },
  );
  const p = e.provider.request({ method: "eth_requestAccounts" });
  e.timers[0]();
  await assert.rejects(p, { code: -32002 });
  assert.equal(e.sent.length, 1);
});

test("Collection fee policy verifies exact recipients and amounts including fractional percentages", () => {
  const l = parseListing(listing()),
    c = {
      collection: "fixture",
      contracts: [{ chain: "ethereum", address: l.nft }],
      fees: [{ recipient, fee: 1, required: true }],
    };
  assert.equal(collectionFees(c, "fixture", l)[0].basisPoints, "100");
  assert.throws(
    () =>
      collectionFees(
        { ...c, fees: [{ recipient, fee: 2.5, required: true }] },
        "fixture",
        l,
      ),
    /disagrees/,
  );
  assert.throws(
    () => collectionFees({ ...c, fees: [] }, "fixture", l),
    /disagrees/,
  );
  assert.throws(
    () => collectionFees({ ...c, contracts: [] }, "fixture", l),
    /contract/,
  );
});
test("Extension only accepts configured testnet chain events", async () => {
  const e = extension(),
    p = e.provider.request({ method: "eth_requestAccounts" }),
    channel = e.sent[0].m.channel;
  const seen: string[] = [];
  e.provider.on("chainChanged", (v: string) => seen.push(v));
  e.receive({ protocol: "zecone:2", kind: "ready", channel, chainId: "0x1" });
  assert.equal(e.sent.length, 1);
  e.receive({
    protocol: "zecone:2",
    kind: "ready",
    channel,
    chainId: "0x14a34",
  });
  e.receive({
    protocol: "zecone:2",
    kind: "event",
    channel,
    event: "chainChanged",
    value: "0x1",
  });
  e.receive({
    protocol: "zecone:2",
    kind: "event",
    channel,
    event: "chainChanged",
    value: "0xaa36a7",
  });
  assert.deepEqual(seen, ["0xaa36a7"]);
  e.receive({
    protocol: "zecone:2",
    kind: "event",
    channel,
    event: "disconnect",
  });
  await assert.rejects(p, { code: 4900 });
});
test("OpenSea HTTP API requires local verified session and CSRF and has no payment route", async () => {
  const db = new DatabaseSync(":memory:"),
    sessions = new Sessions(db);
  let calls = 0;
  const preview = {
    catalog: async () => {
      calls++;
      return { listings: [] };
    },
  } as any;
  const server = createServer(
    walletApi(
      sessions,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      preview,
    ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  const send = (path: string, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const r = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            Host: "127.0.0.1:3210",
            Origin: ORIGIN,
            "Content-Type": "application/json",
            ...headers,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      r.on("error", reject);
      r.end(JSON.stringify({ collection: "fixture" }));
    });
  try {
    assert.equal(await send("/api/opensea/listings"), 401);
    const p = sessions.pair(sessions.issuePairing()),
      headers = {
        Cookie: `zecone_session=${p.cookie}`,
        "x-zecone-csrf": p.session.csrf,
      };
    assert.equal(await send("/api/opensea/listings", headers), 403);
    db.prepare("UPDATE sessions SET connected=1 WHERE id=?").run(p.session.id);
    assert.equal(
      await send("/api/opensea/listings", {
        ...headers,
        Origin: "https://opensea.io",
      }),
      403,
    );
    assert.equal(
      await send("/api/opensea/listings", { Cookie: headers.Cookie }),
      403,
    );
    assert.equal(calls, 0);
    assert.equal(await send("/api/opensea/listings", headers), 200);
    assert.equal(calls, 1);
    assert.equal(await send("/api/opensea/pay", headers), 404);
    sessions.disconnect(p.session);
    assert.equal(await send("/api/opensea/listings", headers), 401);
  } finally {
    server.close();
    await once(server, "close");
    db.close();
  }
});
