// Local synthetic regression tests. No historical credentials, RPCs or broadcasts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { runInNewContext } from "node:vm";
import { encodeFunctionData, parseAbi } from "viem";
import { message, describeCall } from "../services/wallet/dapp-policy.ts";
import { Dapps } from "../services/wallet/dapps.ts";
import { Sessions } from "../services/wallet/security.ts";
import { snapshotApi } from "../services/wallet/snapshot-api.ts";
import {
  copyDatabase,
  readonlyStore,
  digest,
} from "../services/wallet/snapshot.ts";
const user = "0x1111111111111111111111111111111111111111";
test("EIP-1193 duplicate listener and removal semantics preserve other wallets", () => {
  let provider: any;
  const handlers = new Map<string, Function>();
  const other = Object.freeze({ wallet: "other" });
  const w: any = {
    ethereum: other,
    addEventListener: (name: string, fn: Function) => handlers.set(name, fn),
    dispatchEvent: (e: any) => {
      provider = e.detail.provider;
    },
  };
  w.top = w;
  runInNewContext(readFileSync("extension/inpage.js", "utf8"), {
    window: w,
    location: { origin: "https://fixture.example" },
    crypto: { randomUUID },
    CustomEvent: class {
      constructor(
        public type: string,
        public detail: any,
      ) {
        this.detail = detail.detail;
      }
    },
    setTimeout,
    clearTimeout,
  });
  assert.equal(w.ethereum, other);
  assert.equal(provider.isMetaMask, undefined);
  let calls = 0;
  const fn = () => calls++;
  provider.on("accountsChanged", fn).on("accountsChanged", fn);
  const emit = () =>
    handlers.get("message")!({
      source: w,
      origin: "https://fixture.example",
      data: {
        protocol: "zecone:extension:1",
        direction: "response",
        kind: "event",
        event: "accountsChanged",
        value: [],
      },
    });
  emit();
  assert.equal(calls, 2);
  provider.removeListener("accountsChanged", fn);
  emit();
  assert.equal(calls, 3);
  provider.removeListener("accountsChanged", fn);
  emit();
  assert.equal(calls, 3);
  assert.equal(Object.isFrozen(provider), true);
});
test("personal_sign standard and unambiguous legacy orders stay bound to the authorized account", () => {
  assert.equal(message(["0x1234", user], user), "0x1234");
  assert.equal(message([user, "0x1234"], user), "0x1234");
  assert.equal(message([user, user], user), user); // standard form wins
  const other = "0x2222222222222222222222222222222222222222";
  assert.throws(() => message([user, other], user), /ambiguous/);
  assert.throws(() => message(["0x12", other], user), /mismatch/);
  assert.throws(() => message([user, "not hex"], user));
  assert.throws(() => message(["0x12"], user));
});
test("known approval review distinguishes unlimited allowance and collection-wide authority", () => {
  const abi = parseAbi([
    "function approve(address,uint256)",
    "function setApprovalForAll(address,bool)",
  ]);
  const allowance = (amount: bigint) =>
    describeCall(
      encodeFunctionData({
        abi,
        functionName: "approve",
        args: [user, amount],
      }),
    ).warning;
  assert.match(allowance((1n << 256n) - 1n), /UNLIMITED/);
  assert.doesNotMatch(allowance(1n), /UNLIMITED/);
  const all = (approved: boolean) =>
    describeCall(
      encodeFunctionData({
        abi,
        functionName: "setApprovalForAll",
        args: [user, approved],
      }),
    ).warning;
  assert.match(all(true), /ALL NFTs/);
  assert.doesNotMatch(all(false), /ALL NFTs/);
  assert.match(describeCall("0x12345678").warning, /Undecoded/);
});
test("rejection-only connector routes reviews but cannot approve signatures or transactions", async () => {
  const d = new Dapps(user, ":memory:", undefined, { signingDisabled: true });
  const s = {
    id: "isolated",
    csrf: "x",
    connected: 1,
    expires: Date.now() + 60000,
  };
  const origin = "https://fixture.example",
    channel = randomUUID();
  try {
    d.db.prepare("INSERT INTO permissions VALUES(?,?)").run(origin, Date.now());
    const request = (await d.request(s, {
      id: randomUUID(),
      channel,
      origin,
      method: "personal_sign",
      params: ["0x1234", user],
    })) as any;
    await assert.rejects(
      d.approve(s, request.id, request.reviewHash, true),
      /disabled/,
    );
    assert.equal(d.row(request.id)?.state, "pending");
    await d.approve(s, request.id, request.reviewHash, false);
    assert.equal(d.row(request.id)?.state, "rejected");
    // Even an exact persisted review for a transaction cannot reach a signer.
    for (const method of [
      "eth_sendTransaction",
      "eth_signTypedData_v4",
      "zecone_payWithZec",
    ]) {
      const id = randomUUID();
      d.db
        .prepare(
          "INSERT INTO requests SELECT ?,channel,origin,session,?,params,fingerprint,review,review_hash,'pending',NULL,NULL,expires,NULL,created FROM requests WHERE id=?",
        )
        .run(id, method, request.id);
      await assert.rejects(
        d.approve(s, id, d.row(id)!.review_hash, true),
        /disabled/,
      );
      assert.equal(d.row(id)?.state, "pending");
    }
  } finally {
    d.db.close();
  }
});
test("snapshot copy preserves source bytes and read-only store refuses writes", () => {
  const root = ".state/phase6c/snapshots";
  mkdirSync(root, { recursive: true });
  const dir = join(root, randomUUID());
  mkdirSync(dir);
  const source = join(dir, "source.sqlite");
  const db = new DatabaseSync(source);
  db.exec(
    "CREATE TABLE orders(id TEXT PRIMARY KEY,state TEXT); INSERT INTO orders VALUES('id','prepared');",
  );
  db.close();
  const before = digest(source),
    copy = copyDatabase(source, join(dir, "copy"));
  const store = readonlyStore(copy);
  try {
    assert.equal(store.get("id")?.state, "prepared");
    assert.throws(() => store.db.exec("DELETE FROM orders"), /readonly/i);
  } finally {
    store.close();
  }
  assert.equal(digest(source), before);
  assert.deepEqual(readFileSync(source), readFileSync(copy));
  assert.throws(
    () => copyDatabase(source, join(".state/phase6c", randomUUID())),
    /snapshot_copy_required/,
  );
});
test("transaction dry-run displays simulation and gas and rejection never signs or duplicates a request", async () => {
  const d = new Dapps(user, ":memory:", undefined, { signingDisabled: true });
  const s = {
    id: "dry-run",
    csrf: "x",
    connected: 1,
    expires: Date.now() + 60000,
  };
  const origin = "https://fixture.example",
    channel = randomUUID();
  let simulations = 0;
  (d as any).public = {
    getChainId: async () => 84532,
    call: async () => {
      simulations++;
    },
    estimateGas: async () => 21000n,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    }),
    getTransactionCount: async () => 0,
  };
  try {
    d.db.prepare("INSERT INTO permissions VALUES(?,?)").run(origin, Date.now());
    const input = {
      id: randomUUID(),
      channel,
      origin,
      method: "eth_sendTransaction",
      params: [{ from: user, to: user, value: "0x0", chainId: "0x14a34" }],
    };
    const reviewed = (await d.request(s, input)) as any;
    assert.equal(reviewed.state, "pending");
    assert.match(reviewed.review.simulation, /succeeded/);
    assert.equal(reviewed.review.estimatedGas, "21000");
    assert.equal(reviewed.review.to, user);
    assert.equal(((await d.request(s, input)) as any).id, reviewed.id);
    assert.equal(simulations, 1);
    await assert.rejects(
      d.approve(s, reviewed.id, reviewed.reviewHash, true),
      /disabled/,
    );
    await d.approve(s, reviewed.id, reviewed.reviewHash, false);
    assert.equal(d.row(reviewed.id)?.state, "rejected");
    assert.equal(d.row(reviewed.id)?.tx_hash, null);
    await assert.rejects(
      d.request(s, {
        ...input,
        params: [{ from: user, to: user, value: "0x1" }],
      }),
      /replay/,
    );
  } finally {
    d.db.close();
  }
});
test("read-only API requires local pairing, never asserts ownership and denies every spending route", async () => {
  const db = new DatabaseSync(":memory:"),
    sessions = new Sessions(db),
    token = sessions.issuePairing();
  const handler = snapshotApi(sessions, {
    capturedAt: "fixture",
    dashboard: { address: user },
    checkouts: [],
    networks: [],
    lists: { purchase: [], swap: [], seaport: [] },
  });
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const call = (
    path: string,
    method = "GET",
    headers: Record<string, string> = {},
    body?: unknown,
  ) =>
    new Promise<{
      status: number;
      json: () => Promise<any>;
      headers: { get: (name: string) => string | null };
    }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: `/api/${path}`,
          method,
          headers: { Host: "127.0.0.1:3210", ...headers },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              json: async () => JSON.parse(data),
              headers: {
                get: (name) => {
                  const v = res.headers[name];
                  return Array.isArray(v) ? v[0] : (v ?? null);
                },
              },
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    assert.equal((await call("dashboard")).status, 401);
    assert.equal(
      (await call("health", "GET", { Origin: "https://evil.example" })).status,
      403,
    );
    const local = {
      Origin: "http://127.0.0.1:3210",
      "Content-Type": "application/json",
    };
    const paired = await call("pair", "POST", local, { token });
    assert.equal(paired.status, 200);
    const session = (await paired.json()) as any;
    assert.equal(session.connected, false);
    assert.equal(session.readOnly, true);
    const Cookie = paired.headers.get("set-cookie")!.split(";")[0];
    const headers = { ...local, Cookie, "x-zecone-csrf": session.csrf };
    for (const path of [
      "pay",
      "quote",
      "refresh",
      "connect",
      "checkouts/payment-request",
      "dapps/approve",
      "refund/sign",
      "refund/broadcast",
      "purchases/pay",
      "swaps/pay",
      "seaport/pay",
    ])
      assert.equal((await call(path, "POST", headers, {})).status, 403, path);
    assert.equal((await call("dashboard", "GET", { Cookie })).status, 200);
    assert.equal((await call("session", "GET", { Cookie })).status, 200);
    assert.equal((await call("checkouts", "GET", { Cookie })).status, 200);
    assert.equal((await call("logout", "POST", headers, {})).status, 200);
    assert.equal((await call("dashboard", "GET", { Cookie })).status, 401);
    assert.equal((await call("pair", "POST", local, { token })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
});
