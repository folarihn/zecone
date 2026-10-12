// Synthetic fixtures only. No network, real keys, or broadcasts in this test file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  Sessions,
  requireLocal,
  ORIGIN,
  type Session,
} from "../services/wallet/security.ts";
import { AppState } from "../services/wallet/state.ts";
import { Engine, requireApproval } from "../services/wallet/engine.ts";
import { Store, type Snapshot } from "../services/execution/store.ts";
import { orderId, type Intent } from "../services/execution/intent.ts";
import { checkoutView, progress } from "../services/wallet/view.ts";
import { api } from "../services/wallet/api.ts";
const s: Session = {
  id: "fixture-session",
  csrf: "1".repeat(64),
  connected: 1,
  expires: Date.now() + 600000,
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "zecone-browser-test-")),
    app = new AppState(join(dir, "app.sqlite")),
    store = new Store(join(dir, "orders.sqlite"));
  const user = privateKeyToAccount(generatePrivateKey()),
    contract = privateKeyToAccount(generatePrivateKey()).address;
  const intent: Intent = {
    recipient: user.address,
    contract,
    zatoshis: "1000000",
    nonce: `0x${"a".repeat(64)}`,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    signature: "0x1234",
  };
  const id = randomUUID(),
    oid = orderId(intent),
    account = randomUUID();
  store.create(
    oid,
    intent,
    account,
    "utest-FIXTURE-PRIVATE-RECEIVER",
    Math.floor(Date.now() / 1000),
  );
  app.db
    .prepare(
      "INSERT INTO checkouts(id,intent,order_id,request_id,stage,created) VALUES(?,?,?,?,?,?)",
    )
    .run(
      id,
      JSON.stringify(intent),
      oid,
      randomUUID(),
      "awaiting",
      Date.now() / 1000,
    );
  const e = Object.create(Engine.prototype) as Engine;
  Object.assign(e, {
    app,
    store,
    address: user.address,
    contract,
    manifest: { zcash: { payer: { account } } },
    approvalDir: join(dir, "approvals"),
    tail: Promise.resolve(),
    queued: 0,
    zcash: null,
    base: null,
    nfts: [],
    health: { zcash: "Fixture", base: "Fixture", worker: "Fixture" },
  });
  return {
    app,
    store,
    e,
    id,
    oid,
    account,
    intent,
    user,
    close() {
      app.close();
      store.close();
    },
  };
}
test("pairing is one use, cookie is hashed, sessions expire and revoke", () => {
  const db = new DatabaseSync(":memory:");
  let now = 1000;
  const sessions = new Sessions(db, () => now),
    token = sessions.issuePairing();
  const { cookie, session } = sessions.pair(token);
  assert.throws(() => sessions.pair(token));
  assert.notEqual(session.id, cookie);
  assert.equal(sessions.get(`zecone_session=${cookie}`).id, session.id);
  assert.throws(() => sessions.get("zecone_session=invalid"));
  sessions.csrf(session, session.csrf);
  assert.throws(() => sessions.csrf(session, undefined));
  assert.throws(() => sessions.csrf(session, "é".repeat(64)));
  now = session.expires;
  assert.throws(() => sessions.get(`zecone_session=${cookie}`));
  now = 1000;
  const b = sessions.pair(sessions.issuePairing());
  sessions.disconnect(b.session);
  assert.throws(() => sessions.get(`zecone_session=${b.cookie}`));
  db.close();
});
test("Host, Origin, fetch metadata and JSON gate reject cross-site requests", () => {
  const h = {
    host: "127.0.0.1:3210",
    origin: ORIGIN,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };
  requireLocal(h, true);
  for (const x of [
    { ...h, host: "evil.example" },
    { ...h, origin: "https://evil.example" },
    { ...h, origin: undefined },
    { ...h, "sec-fetch-site": "cross-site" },
    { ...h, "content-type": "text/plain" },
  ])
    assert.throws(() => requireLocal(x, true));
});
test("unconnected or unapproved operations never invoke signing", async () => {
  const f = fixture();
  let calls = 0;
  (f.e as any).script = async () => {
    calls++;
  };
  (f.e as any).native = async () => {
    calls++;
  };
  assert.throws(() => requireApproval({ ...s, connected: 0 }, true));
  await assert.rejects(f.e.create(s, randomUUID(), false));
  await assert.rejects(f.e.create({ ...s, connected: 0 }, randomUUID(), true));
  assert.throws(() => f.e.pay(s, f.id, randomUUID(), false));
  await assert.rejects(f.e.connect(s, randomUUID(), false));
  assert.equal(calls, 0);
  f.close();
});
test("ownership challenge verifies signature, is session-bound and cannot replay", async () => {
  const f = fixture();
  new Sessions(f.app.db);
  f.app.db
    .prepare("INSERT INTO sessions VALUES(?,?,?,0)")
    .run(s.id, s.csrf, s.expires);
  const challenge = f.e.challenge(s);
  (f.e as any).script = async () => ({
    signature: await f.user.signMessage({ message: challenge.message }),
  });
  await assert.rejects(
    f.e.connect({ ...s, id: "another-session" }, challenge.id, true),
  );
  await f.e.connect(s, challenge.id, true);
  assert.equal(
    (
      f.app.db
        .prepare("SELECT connected FROM sessions WHERE id=?")
        .get(s.id) as any
    ).connected,
    1,
  );
  await assert.rejects(f.e.connect(s, challenge.id, true));
  f.close();
});
test("tampered ownership signature fails closed", async () => {
  const f = fixture(),
    c = f.e.challenge(s);
  (f.e as any).script = async () => ({
    signature: await f.user.signMessage({ message: c.message + "tampered" }),
  });
  await assert.rejects(f.e.connect(s, c.id, true), /ownership/);
  f.close();
});
test("order creation is idempotent across duplicate and concurrent submissions", async () => {
  const f = fixture();
  f.app.db.exec("DELETE FROM checkouts");
  let signs = 0,
    creates = 0;
  (f.e as any).script = async (name: string) => {
    if (name.includes("local-user")) {
      signs++;
      return { intentFile: "fixture-signed.json" };
    }
    creates++;
    return { id: f.oid };
  };
  const id = randomUUID(),
    [a, b] = await Promise.all([
      f.e.create(s, id, true),
      f.e.create(s, id, true),
    ]);
  assert.equal(a.id, b.id);
  assert.equal(signs, 1);
  assert.equal(creates, 1);
  const active = await f.e.create(s, randomUUID(), true);
  assert.equal(active.id, id);
  assert.equal(signs, 1);
  f.close();
});
test("stale and other-session fee approvals cannot send; duplicate approvals send once", async () => {
  const f = fixture();
  let sends = 0;
  let release!: () => void;
  (f.e as any).native = async () => {
    sends++;
    await new Promise<void>((r) => {
      release = r;
    });
    return { txid: "b".repeat(64) };
  };
  const q = {
    id: randomUUID(),
    feeZatoshis: "20000",
    totalZatoshis: "1020000",
    expires: Date.now() - 1,
  };
  const save = () =>
    f.app.db
      .prepare(
        "UPDATE checkouts SET quote=?,quote_session=?,stage='quoted' WHERE id=?",
      )
      .run(JSON.stringify(q), s.id, f.id);
  save();
  assert.throws(() => f.e.pay(s, f.id, q.id, true));
  q.expires = Date.now() + 60000;
  save();
  assert.throws(() =>
    f.e.pay({ ...s, id: "another-session" }, f.id, q.id, true),
  );
  f.e.pay(s, f.id, q.id, true);
  f.e.pay(s, f.id, q.id, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(sends, 1);
  assert.equal(f.app.get(f.id)!.stage, "sending");
  release();
  await (f.e as any).tail;
  assert.equal(f.app.get(f.id)!.stage, "sent");
  f.close();
});
test("payment approval passes the exact fee ceiling and predetermined destination to native signer", async () => {
  const f = fixture();
  let args: string[] = [];
  (f.e as any).native = async (a: string[]) => {
    args = a;
    return { txid: "c".repeat(64) };
  };
  const q = {
    id: randomUUID(),
    feeZatoshis: "20000",
    expires: Date.now() + 60000,
  };
  f.app.db
    .prepare(
      "UPDATE checkouts SET quote=?,quote_session=?,stage='quoted' WHERE id=?",
    )
    .run(JSON.stringify(q), s.id, f.id);
  f.e.pay(s, f.id, q.id, true);
  await (f.e as any).tail;
  assert.equal(args[args.indexOf("--max-fee-zatoshis") + 1], "20000");
  assert.equal(
    args[args.indexOf("--address") + 1],
    "utest-FIXTURE-PRIVATE-RECEIVER",
  );
  assert.equal(
    args[args.indexOf("--request-id") + 1],
    f.app.get(f.id)!.request_id,
  );
  f.close();
});
test("restarted in-flight actions require review and never silently resend", () => {
  const f = fixture();
  f.app.update(f.id, "sending");
  f.e.recoverInterrupted();
  assert.equal(f.app.get(f.id)!.stage, "review");
  assert.equal(
    checkoutView(f.app.get(f.id)!, f.store, 100).status,
    "Manual review required",
  );
  f.close();
});
test("nine confirmations remain confirming; ten permit settled and later completed states", () => {
  const f = fixture(),
    now = Math.floor(Date.now() / 1000);
  f.app.update(f.id, "sent");
  const snap: Snapshot = {
    network: "zcash-testnet",
    tip: 100,
    scanned: 100,
    observedAt: now,
    payments: [
      {
        account: f.account,
        txid: "b".repeat(64),
        pool: 4,
        index: 1,
        zatoshis: "1000000",
        height: 92,
        blockHash: "c".repeat(64),
      },
    ],
  };
  f.store.observe(snap, now);
  let view = checkoutView(f.app.get(f.id)!, f.store, 100);
  assert.equal(view.confirmations, 9);
  assert.equal(view.status, "Confirming");
  f.store.observe({ ...snap, tip: 101, scanned: 101 }, now);
  view = checkoutView(f.app.get(f.id)!, f.store, 101);
  assert.equal(view.status, "Settled");
  assert.equal(progress("submitted", "sent", "1000000", 10), "Executing");
  assert.equal(progress("settled", "sent", "1000000", 10), "Completed");
  assert.equal(progress("failed", "sent", "1000000", 10), "Failed");
  assert.equal(
    progress("recovery", "sent", "1000000", 10),
    "Manual review required",
  );
  f.close();
});
test("browser projection omits account IDs, receiving addresses, signatures, nonce and raw transaction", () => {
  const f = fixture();
  const body = JSON.stringify(checkoutView(f.app.get(f.id)!, f.store, 100));
  for (const value of [
    f.account,
    "utest-FIXTURE-PRIVATE-RECEIVER",
    f.intent.signature,
    f.intent.nonce,
    "request_id",
    "quote_session",
    "account_uuid",
    "raw",
    "intent",
  ])
    assert.ok(!body.includes(value), value);
  f.close();
});
test("HTTP boundary blocks unauthenticated, CSRF and cross-origin signing attempts before dispatch", async () => {
  const db = new DatabaseSync(":memory:"),
    sessions = new Sessions(db);
  let calls = 0;
  const engine = {
    create: async () => {
      calls++;
      return {};
    },
    dashboard: () => ({ private: true }),
  } as any;
  const server = createServer(api(sessions, engine));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  const send = (path: string, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
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
      req.on("error", reject);
      req.end(JSON.stringify({ id: randomUUID(), approved: true }));
    });
  try {
    assert.equal(await send("/api/checkout"), 401);
    const p = sessions.pair(sessions.issuePairing()),
      Cookie = `zecone_session=${p.cookie}`;
    assert.equal(await send("/api/checkout", { Cookie }), 403);
    assert.equal(
      await send("/api/checkout", {
        Cookie,
        Origin: "https://evil.test",
        "x-zecone-csrf": p.session.csrf,
      }),
      403,
    );
    assert.equal(calls, 0);
    assert.equal(
      await send("/api/checkout", { Cookie, "x-zecone-csrf": p.session.csrf }),
      200,
    );
    assert.equal(calls, 1);
  } finally {
    server.close();
    await once(server, "close");
    db.close();
  }
});
