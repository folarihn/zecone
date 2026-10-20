// Synthetic watch/RPC fixtures and disposable keys only. Not live settlement evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, parseTransaction, type Hex } from "viem";
import { Store } from "../services/execution/store.ts";
import { EvmTransferSettlement } from "../services/settlement/evm-transfer.ts";
import { NativeTransferFlow } from "../services/settlement/native-transfer-flow.ts";
import { EvmTransferExecutor } from "../services/evm/transfers.ts";
import { network } from "../services/evm/networks.ts";
import type { WatchSnapshot } from "../services/signer/watch-evidence.ts";
import { Dapps } from "../services/wallet/dapps.ts";
import { IntentReviews } from "../services/wallet/transaction-intents.ts";
import { nativeIntentHandoff } from "../services/wallet/native-intent-handoff.ts";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { Sessions } from "../services/wallet/security.ts";
import { nativeTransferApi } from "../services/wallet/native-transfer-api.ts";
import { SourceBindings } from "../services/settlement/source-bindings.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const hash = `0x${"a".repeat(64)}` as Hex;
async function fixture(file = ":memory:") {
  const user = privateKeyToAccount(generatePrivateKey()),
    relayer = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey()).address,
    store = new Store(file);
  let time = 1000,
    balance = 10n ** 18n,
    submissions = 0,
    lost = false,
    finalized = false,
    raw: Hex | undefined;
  const adapter: any = {
    chainId: 84532,
    policy: network(84532),
    health: async () => ({ chainId: 84532, block: "100", hash }),
    prepare: async () => ({
      nonce: 0,
      gas: 25201n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      feeCap: 40000000025201n,
    }),
    client: {
      getBalance: async () => balance,
      getBytecode: async () => "0x",
      getTransactionCount: async () => 0,
      getTransaction: async () => {
        const tx = parseTransaction(raw!);
        return {
          from: relayer.address,
          to: tx.to,
          value: tx.value,
          input: tx.data ?? "0x",
        };
      },
    },
    submit: async (wire: Hex) => {
      submissions++;
      raw = wire;
      if (lost) throw Error("lost response");
      return keccak256(wire);
    },
    receipt: async (signature: Hex) =>
      finalized
        ? {
            status: "success",
            transactionHash: signature,
            blockNumber: 100n,
            logs: [],
          }
        : null,
  };
  const settlement = new EvmTransferSettlement(store, adapter, () => time);
  const flow = new NativeTransferFlow(
    settlement,
    user.address,
    new SourceBindings(store.db, randomUUID()),
  );
  const request = {
    profileId: randomUUID(),
    requestId: randomUUID(),
    recipient,
    relayer: relayer.address,
    amount: "1000000000000",
    asset: { kind: "native" as const },
    feeCapWei: "100000000000000",
    account: "a".repeat(64),
    paymentAddress: "utest1_SYNTHETIC_ONLY",
  };
  const review = await flow.review("session", request);
  const signature = await user.signMessage({ message: review.message });
  const authorize = async () => {
    await flow.authorize("session", review.id, signature, true);
    return store.all()[0].id;
  };
  const snapshot = (confirmations = 10, amount = "100000"): WatchSnapshot => ({
    network: "zcash-testnet",
    tip: 1000,
    scanned: 1000,
    observedAt: time,
    watchOnly: true,
    liveChain: true,
    liveRefundsEnabled: false,
    source: "https://testnet.zec.rocks:443",
    account: request.account,
    address: request.paymentAddress,
    birthday: 800,
    blockHash: "b".repeat(64),
    payments: [
      {
        account: request.account,
        txid: "c".repeat(64),
        pool: 4,
        index: 0,
        zatoshis: amount,
        height: 1001 - confirmations,
        blockHash: "d".repeat(64),
      },
    ],
    native: {
      fullViewingKey: "e".repeat(192),
      anchor: "f".repeat(64),
      anchorHeight: 991,
      inputs: [
        {
          paymentKey: `${"c".repeat(64)}:4:0`,
          zatoshis: amount,
          minedHeight: 1001 - confirmations,
          nullifier: "1".repeat(64),
        } as any,
      ],
    },
  });
  const executor = new EvmTransferExecutor(adapter, relayer, 3, () => time);
  return {
    flow,
    store,
    request,
    review,
    signature,
    user,
    executor,
    adapter,
    authorize,
    snapshot,
    scan: async (id: string, s = snapshot()) =>
      flow.observe(id, { observe: async () => s }),
    time: (v: number) => (time = v),
    liquidity: (v: bigint) => (balance = v),
    lost: () => (lost = true),
    finalize: () => (finalized = true),
    submissions: () => submissions,
  };
}
test("wallet authorization, owned-note verification and original executor settle exactly once", async () => {
  const f = await fixture(),
    id = await f.authorize();
  assert.equal(f.flow.status("session", f.review.id).state, "PAYMENT_PENDING");
  assert.equal((await f.scan(id, f.snapshot(1))).state, "PAYMENT_DETECTED");
  await assert.rejects(f.flow.execute(id, f.executor, true), /PAYMENT/);
  assert.equal((await f.scan(id)).state, "PAYMENT_CONFIRMED");
  await assert.rejects(f.flow.execute(id, f.executor, false), /OPERATOR/);
  const executing = await f.flow.execute(id, f.executor, true);
  assert.equal(executing.state, "EXECUTING");
  assert.ok(f.store.get(id)!.raw);
  assert.equal(f.submissions(), 1);
  f.finalize();
  // Receipt reconciliation must work after the original payment/order deadline.
  f.time(10000);
  const readOnlyExecutor = new EvmTransferExecutor(
    f.adapter,
    { type: "json-rpc", address: f.request.relayer },
    3,
    () => 10000,
  );
  assert.equal(
    (await f.flow.reconcile(id, readOnlyExecutor)).state,
    "COMPLETED",
  );
  await assert.rejects(f.flow.execute(id, f.executor, true), /DUPLICATE/);
  assert.equal(f.submissions(), 1);
  f.store.close();
});
test("wrong authorizer, changed signature, session and expired quote cannot create an order", async () => {
  const f = await fixture();
  await assert.rejects(
    f.flow.authorize("other", f.review.id, f.signature, true),
  );
  const wrong = await privateKeyToAccount(generatePrivateKey()).signMessage({
    message: f.review.message,
  });
  await assert.rejects(
    f.flow.authorize("session", f.review.id, wrong, true),
    /AUTHORIZATION/,
  );
  f.time(1090);
  await assert.rejects(f.authorize(), /REVIEW/);
  assert.equal(f.store.all().length, 0);
  f.store.close();
});
test("underpayment, wrong watch account, missing owned note and excess payments never execute", async () => {
  const f = await fixture(),
    id = await f.authorize();
  assert.equal(
    (await f.scan(id, f.snapshot(10, "99999"))).state,
    "PAYMENT_DETECTED",
  );
  await assert.rejects(f.flow.execute(id, f.executor, true), /PAYMENT/);
  await assert.rejects(
    f.scan(id, { ...f.snapshot(), account: "9".repeat(64) }),
  );
  const s = f.snapshot();
  s.native.inputs = [];
  await assert.rejects(f.scan(id, s), /OWNED/);
  // A fresh distinct observation, not mutation of the previously seen note amount.
  const excess = f.snapshot(10, "100001");
  excess.payments[0].txid = "8".repeat(64);
  excess.native.inputs[0].paymentKey = `${"8".repeat(64)}:4:0`;
  assert.equal((await f.scan(id, excess)).state, "RECOVERY_REQUIRED");
  assert.equal(f.submissions(), 0);
  f.store.close();
});
test("lost broadcast response survives coordinator restart and only reconciles original hash", async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "zecone-native-restart-")),
    "orders.sqlite",
  );
  const f = await fixture(path),
    id = await f.authorize();
  await f.scan(id);
  f.lost();
  await assert.rejects(f.flow.execute(id, f.executor, true), /lost/);
  assert.ok(f.store.get(id)!.raw);
  assert.ok(f.store.get(id)!.tx_hash);
  f.store.close();
  const reopened = new Store(path);
  const restarted = new NativeTransferFlow(
    new EvmTransferSettlement(reopened, f.adapter, () => 1000),
    f.user.address,
  );
  assert.equal(
    (await restarted.execute(id, f.executor, true)).state,
    "RECOVERY_REQUIRED",
  );
  assert.equal(f.submissions(), 1);
  f.finalize();
  assert.equal((await restarted.reconcile(id, f.executor)).state, "COMPLETED");
  assert.equal(f.submissions(), 1);
  reopened.close();
});
test("concurrent execution, drained liquidity and payment reorg fail closed", async () => {
  const f = await fixture(),
    id = await f.authorize();
  await f.scan(id);
  f.liquidity(0n);
  await assert.rejects(f.flow.execute(id, f.executor, true), /LIQUIDITY/);
  f.liquidity(10n ** 18n);
  const results = await Promise.allSettled([
    f.flow.execute(id, f.executor, true),
    f.flow.execute(id, f.executor, true),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.submissions(), 1);
  f.store.close();
  const other = await fixture(),
    oid = await other.authorize();
  await other.scan(oid);
  const empty = other.snapshot();
  empty.payments = [];
  empty.native.inputs = [];
  assert.equal((await other.scan(oid, empty)).state, "RECOVERY_REQUIRED");
  await assert.rejects(other.flow.execute(oid, other.executor, true));
  other.store.close();
});
test("session revocation after asynchronous review revalidation cancels financial creation", async () => {
  const f = await fixture();
  let checks = 0;
  await assert.rejects(
    f.flow.authorize("session", f.review.id, f.signature, true, () => {
      if (++checks > 1) throw Error("revoked");
    }),
    /revoked/,
  );
  assert.equal(f.store.all().length, 0);
  f.store.close();
});
test("consented dApp request enters distinct native checkout and revocation blocks reuse", async () => {
  const f = await fixture(),
    origin = "https://transfer-fixture.example";
  const dapps = new Dapps(f.user.address, ":memory:", undefined, {
    signingDisabled: true,
    intents: new IntentReviews(),
  });
  const session = {
    id: "session",
    connected: 1,
    csrf: "fixture",
    expires: Date.now() + 600000,
  };
  dapps.db
    .prepare("INSERT INTO permissions VALUES(?,?)")
    .run(origin, Date.now());
  const id = randomUUID();
  const preview: any = await dapps.request(session, {
    id,
    channel: randomUUID(),
    origin,
    method: "eth_sendTransaction",
    params: [
      {
        from: f.user.address,
        to: f.request.recipient,
        data: "0x",
        value: `0x${BigInt(f.request.amount).toString(16)}`,
      },
    ],
  });
  const consent: any = await dapps.approve(
    session,
    id,
    preview.reviewHash,
    true,
  );
  assert.ok(consent.error);
  assert.equal(consent.result, undefined);
  const context = dapps.nativeTransferContext(session, id);
  const handoff = nativeIntentHandoff(context, [origin]);
  assert.equal(handoff.standardTransactionExecuted, false);
  const fresh = await f.flow.review(
    "session",
    { ...f.request, amount: handoff.amount, recipient: handoff.recipient },
    handoff.source,
  );
  assert.equal(fresh.source!.origin, origin);
  assert.equal(fresh.financialOrderCreated, false);
  assert.throws(() =>
    nativeIntentHandoff(context, ["https://unapproved.example"]),
  );
  dapps.revoke(origin);
  assert.throws(() => nativeIntentHandoff(context, [origin]));
  assert.equal(f.store.all().length, 0);
  dapps.db.close();
  f.store.close();
});
test("authenticated wallet API authorizes one order, reveals scoped request and reports native scan", async (t) => {
  const f = await fixture(),
    sessions = new Sessions(f.store.db),
    pair = sessions.pair(sessions.issuePairing());
  f.store.db
    .prepare("UPDATE sessions SET connected=1 WHERE id=?")
    .run(pair.session.id);
  const { recipient, amount, asset: _asset, ...profile } = f.request;
  const server = createServer(
    nativeTransferApi(sessions, f.flow, profile, [recipient], true),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.store.close();
  });
  const post = (path: string, body: unknown, csrf = pair.session.csrf) =>
    new Promise<any>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: (server.address() as any).port,
          path: `/api/native-transfer/${path}`,
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
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () =>
            resolve({ status: res.statusCode, data: JSON.parse(raw) }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  assert.equal(
    (await post("review", { recipient, amount }, "wrong")).status,
    403,
  );
  assert.equal(
    (await post("review", { recipient, amount, calldata: "0xab" })).status,
    400,
  );
  const quote = await post("review", { recipient, amount });
  assert.equal(quote.status, 200);
  const signature = await f.user.signMessage({ message: quote.data.message });
  const authorized = await post("authorize", {
    id: quote.data.id,
    signature,
    approved: true,
  });
  assert.equal(authorized.data.state, "PAYMENT_PENDING");
  assert.equal(
    (await post("authorize", { id: quote.data.id, signature, approved: true }))
      .status,
    400,
  );
  const payment = await post("payment-request", {
    id: quote.data.id,
    reveal: true,
  });
  assert.equal(payment.data.zatoshis, "100000");
  await f.scan(f.store.all()[0].id);
  assert.equal(
    (await post("status", { id: quote.data.id })).data.state,
    "PAYMENT_CONFIRMED",
  );
  assert.equal((await post("sign", {})).status, 404);
  assert.equal((await post("broadcast", {})).status, 404);
  assert.equal(f.submissions(), 0);
});
test("interrupted signing claim and unsupported token/contract recipients fail closed", async () => {
  const f = await fixture(),
    id = await f.authorize();
  await f.scan(id);
  f.store.db
    .prepare(
      "UPDATE native_transfer_authority SET execution_claim=1 WHERE order_id=?",
    )
    .run(id);
  const restarted = new NativeTransferFlow(f.flow.settlement, f.user.address);
  assert.equal(
    restarted.status("session", f.review.id).state,
    "RECOVERY_REQUIRED",
  );
  await assert.rejects(restarted.execute(id, f.executor, true));
  f.store.close();
  const other = await fixture();
  await assert.rejects(
    other.flow.review("session", {
      ...other.request,
      asset: { kind: "ERC20", address: other.request.recipient, decimals: 6 },
    }),
    /NATIVE_ONLY/,
  );
  other.adapter.client.getBytecode = async () => "0x6001";
  await assert.rejects(other.flow.review("session", other.request), /EOA/);
  other.store.close();
});
test("generic JSON observation, failed native reads and overlapping watch scans cannot authorize signing", async () => {
  const f = await fixture(),
    id = await f.authorize();
  f.store.observe(f.snapshot(), 1000);
  await assert.rejects(f.flow.execute(id, f.executor, true), /NATIVE_WATCH/);
  await f.scan(id);
  await assert.rejects(
    f.flow.observe(id, {
      observe: async () => {
        throw Error("RPC unavailable");
      },
    }),
  );
  await assert.rejects(f.flow.execute(id, f.executor, true), /NATIVE_WATCH/);
  let release!: (s: WatchSnapshot) => void;
  const scan = f.flow.observe(id, {
    observe: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await assert.rejects(f.scan(id), /CLAIMED/);
  await assert.rejects(f.flow.execute(id, f.executor, true), /NATIVE_WATCH/);
  release(f.snapshot());
  assert.equal((await scan).state, "PAYMENT_CONFIRMED");
  assert.equal(f.submissions(), 0);
  f.store.close();
});
test("desktop replay index rejects source reuse across wallet journals and historical accounts", () => {
  const db = new DatabaseSync(":memory:");
  const first = new SourceBindings(db, "wallet-one"),
    second = new SourceBindings(db, "wallet-two");
  first.claim("source-account", "private-receiver", "order-one");
  first.claim("source-account", "private-receiver", "order-one");
  assert.throws(
    () => second.claim("source-account", "private-receiver", "order-two"),
    /ALREADY_BOUND/,
  );
  const historical = new SourceBindings(db, "wallet-three", () => [
    "historical-source",
  ]);
  assert.throws(
    () =>
      historical.claim("historical-source", "fresh-receiver", "order-three"),
    /HISTORICAL/,
  );
  assert.doesNotMatch(
    JSON.stringify(db.prepare("SELECT * FROM source_bindings").all()),
    /source-account|private-receiver|wallet-one/,
  );
  db.close();
});
test("signer-returned bytes cannot change the recipient, amount or transaction policy", async () => {
  const f = await fixture(),
    id = await f.authorize();
  await f.scan(id);
  const account = f.executor.account as any;
  const wrong = privateKeyToAccount(generatePrivateKey()).address;
  const malicious = {
    ...account,
    signTransaction: (tx: any) => account.signTransaction({ ...tx, to: wrong }),
  };
  const executor = new EvmTransferExecutor(f.adapter, malicious, 3, () => 1000);
  await assert.rejects(f.flow.execute(id, executor, true), /POLICY_MISMATCH/);
  assert.equal(f.submissions(), 0);
  assert.equal(
    f.flow.status("session", f.review.id).state,
    "RECOVERY_REQUIRED",
  );
  f.store.close();
});
test("source receiver substitution and corrupted persisted authority cannot unlock execution", async () => {
  const before = await fixture();
  const row = before.store.db
    .prepare("SELECT payload FROM native_transfer_reviews WHERE id=?")
    .get(before.review.id)!;
  const changed = JSON.parse(String(row.payload));
  changed.request.paymentAddress = "utest1_WRONG_SYNTHETIC_RECEIVER";
  before.store.db
    .prepare("UPDATE native_transfer_reviews SET payload=? WHERE id=?")
    .run(JSON.stringify(changed), before.review.id);
  await assert.rejects(before.authorize(), /REQUEST_CHANGED/);
  assert.equal(before.store.all().length, 0);
  before.store.close();
  const after = await fixture(),
    id = await after.authorize();
  await after.scan(id);
  const other = await privateKeyToAccount(generatePrivateKey()).signMessage({
    message: after.review.message,
  });
  after.store.db
    .prepare(
      "UPDATE native_transfer_authority SET signature=? WHERE order_id=?",
    )
    .run(other, id);
  await assert.rejects(
    after.flow.execute(id, after.executor, true),
    /AUTHORIZATION_REQUIRED/,
  );
  assert.equal(after.submissions(), 0);
  after.store.close();
});
