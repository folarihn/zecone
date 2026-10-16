// Synthetic payment/chain fixtures and ephemeral keys, never live settlement evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, blockhash } from "@solana/kit";
import { Store } from "../services/execution/store.ts";
import {
  SolanaSettlement,
  getCompiledMessage,
  type SettlementNetwork,
} from "../services/solana/settlement.ts";
import type { WatchSnapshot } from "../services/signer/watch-evidence.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
const key = await generateKeyPairSigner(),
  recipient = (await generateKeyPairSigner()).address;
function setup(overrides: any = {}, file = ":memory:") {
  const store = new Store(file);
  let time = 100000,
    sendCount = 0;
  let receipt: any = null;
  const network: SettlementNetwork = {
    balance: async () => 100000000n,
    latest: async () => ({
      blockhash: blockhash("11111111111111111111111111111111"),
      lastValidBlockHeight: 1000n,
    }),
    fee: async () => 5000n,
    valid: async () => true,
    simulate: async () => ({ err: null, unitsConsumed: 150n }) as any,
    send: async () => {
      sendCount++;
      return service.row(id).signature!;
    },
    receipt: async () => receipt,
    ...overrides,
  };
  const service = new SolanaSettlement(store, network, () => time);
  const quote = {
    profileId: randomUUID(),
    requestId: randomUUID(),
    recipient,
    relayer: key.address,
    lamports: "1000000",
    account: "a".repeat(64),
    paymentAddress: "utest1_SYNTHETIC_ONLY",
  };
  const id = service.quote(quote).id;
  const snapshot = (amount = "100000", confirmations = 10): WatchSnapshot => ({
    network: "zcash-testnet",
    watchOnly: true,
    liveChain: true,
    liveRefundsEnabled: false,
    source: "https://testnet.zec.rocks:443",
    account: quote.account,
    address: quote.paymentAddress,
    birthday: 800,
    tip: 1000,
    scanned: 1000,
    observedAt: time,
    blockHash: "b".repeat(64),
    payments: [
      {
        account: quote.account,
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
      anchorHeight: 990,
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
  return {
    store,
    service,
    quote,
    id,
    network,
    snapshot,
    setTime: (t: number) => {
      time = t;
    },
    sends: () => sendCount,
    setReceipt: (r: any) => {
      receipt = r;
    },
  };
}
test("delivery policy rejects wrong network, bad address, self-payment and unsupported amount", () => {
  const x = setup();
  assert.throws(() => x.service.quote({ ...x.quote, recipient: "invalid" }));
  assert.throws(() => x.service.quote({ ...x.quote, recipient: key.address }));
  assert.throws(() => x.service.quote({ ...x.quote, lamports: "1" }));
  x.store.db
    .prepare("UPDATE orders SET intent=? WHERE id=?")
    .run(JSON.stringify({ family: "solana", network: "mainnet" }), x.id);
  assert.throws(() => x.service.intent(x.id), /WRONG_NETWORK/);
  x.store.close();
});
test("one immutable checkout binds recipient and amount; expiry blocks authorization", () => {
  const x = setup();
  assert.equal(x.service.quote(x.quote).id, x.id);
  assert.throws(
    () => x.service.quote({ ...x.quote, recipient: key.address }),
    /DELIVERY_POLICY/,
  );
  assert.throws(
    () => x.service.quote({ ...x.quote, lamports: "2000000" }),
    /IDEMPOTENCY/,
  );
  x.setTime(200000);
  x.service.authorize(x.id, x.snapshot());
  assert.equal(x.service.view(x.id).state, "RECOVERY_REQUIRED");
  assert.throws(() => x.service.eligible(x.id));
  x.store.close();
});
test("unconfirmed, underpaid and missing owned notes cannot authorize spending", () => {
  for (const [amount, depth] of [
    ["99999", 10],
    ["100000", 9],
  ] as const) {
    const x = setup();
    x.service.authorize(x.id, x.snapshot(amount, depth));
    assert.throws(() => x.service.eligible(x.id));
    x.store.close();
  }
  const x = setup(),
    s = x.snapshot();
  s.native.inputs = [];
  assert.throws(() => x.service.authorize(x.id, s), /OWNED_SHIELDED_NOTE/);
  x.store.close();
});
test("duplicate notes never double-count; overpayment enters recovery", () => {
  const x = setup(),
    s = x.snapshot();
  s.payments.push(s.payments[0]);
  assert.throws(() => x.service.authorize(x.id, s));
  x.service.authorize(x.id, x.snapshot("200000"));
  assert.equal(x.service.view(x.id).state, "RECOVERY_REQUIRED");
  assert.throws(() => x.service.eligible(x.id));
  x.store.close();
});
test("insufficient relayer balance, RPC outage and simulation failure enter recovery", async () => {
  for (const overrides of [
    { balance: async () => 0n },
    {
      latest: async () => {
        throw Error("outage");
      },
    },
    { simulate: async () => ({ err: "failure" }) },
  ]) {
    const x = setup(overrides);
    x.service.authorize(x.id, x.snapshot());
    await assert.rejects(x.service.prepare(x.id));
    assert.equal(x.service.view(x.id).state, "RECOVERY_REQUIRED");
    assert.equal(x.sends(), 0);
    x.store.close();
  }
});
test("fresh verified payment prepares, exact approval signs once, finalized exact effects complete", async () => {
  mkdirSync(".state/phase7b/tests", { recursive: true });
  const file = `.state/phase7b/tests/${randomUUID()}.sqlite`;
  const x = setup({}, file);
  x.service.authorize(x.id, x.snapshot());
  const p = await x.service.prepare(x.id);
  await assert.rejects(
    x.service.execute(
      x.id,
      { orderId: x.id, digest: "wrong", approved: true },
      key,
    ),
    /EXACT_APPROVAL/,
  );
  await x.service.execute(
    x.id,
    { orderId: x.id, digest: p.digest, approved: true },
    key,
  );
  assert.equal(x.sends(), 1);
  assert.equal(x.service.view(x.id).state, "EXECUTING");
  const sig = x.service.row(x.id).signature!;
  x.setReceipt({
    version: "legacy",
    transaction: { message: getCompiledMessage(p.wire), signatures: [sig] },
    meta: {
      err: null,
      fee: 5000n,
      preBalances: [100000000n, 0n, 1n],
      postBalances: [98995000n, 1000000n, 1n],
    },
  });
  assert.equal((await x.service.reconcile(x.id)).state, "COMPLETED");
  await assert.rejects(
    x.service.execute(
      x.id,
      { orderId: x.id, digest: p.digest, approved: true },
      key,
    ),
  );
  assert.throws(() => x.service.recover(x.id, "refund"), /COMPLETED/);
  assert.equal((await x.service.reconcile(x.id)).state, "COMPLETED");
  x.store.close();
  const restartedStore = new Store(file),
    restarted = new SolanaSettlement(restartedStore, x.network, () => 100000);
  assert.equal((await restarted.reconcile(x.id)).state, "COMPLETED");
  await assert.rejects(
    restarted.execute(
      x.id,
      { orderId: x.id, digest: p.digest, approved: true },
      key,
    ),
  );
  assert.equal(x.sends(), 1);
  restartedStore.close();
});
test("lost broadcast response persists original signature and never signs a replacement", async () => {
  let calls = 0;
  const x = setup({
    send: async () => {
      calls++;
      throw Error("lost response");
    },
  });
  x.service.authorize(x.id, x.snapshot());
  const p = await x.service.prepare(x.id);
  await x.service.execute(
    x.id,
    { orderId: x.id, digest: p.digest, approved: true },
    key,
  );
  assert.equal(x.service.view(x.id).state, "SUBMISSION_UNCERTAIN");
  assert.ok(x.service.row(x.id).wire);
  assert.ok(x.service.row(x.id).signature);
  await assert.rejects(
    x.service.execute(
      x.id,
      { orderId: x.id, digest: p.digest, approved: true },
      key,
    ),
  );
  await x.service.reconcile(x.id);
  assert.equal(calls, 1);
  x.store.close();
});
test("expired blockhash and payment reorganization veto execution", async () => {
  const x = setup();
  x.service.authorize(x.id, x.snapshot());
  const p = await x.service.prepare(x.id);
  x.network.valid = async () => false;
  await assert.rejects(
    x.service.execute(
      x.id,
      { orderId: x.id, digest: p.digest, approved: true },
      key,
    ),
    /BLOCKHASH_EXPIRED/,
  );
  assert.equal(x.service.view(x.id).state, "RECOVERY_REQUIRED");
  x.store.close();
  const y = setup();
  y.service.authorize(y.id, y.snapshot());
  const s = y.snapshot();
  s.payments = [];
  s.native.inputs = [];
  y.service.authorize(y.id, s);
  assert.throws(() => y.service.eligible(y.id));
  y.store.close();
});
test("failed or mismatched finalized effects cannot complete", async () => {
  for (const bad of ["failed", "amount", "message"]) {
    const x = setup();
    x.service.authorize(x.id, x.snapshot());
    const p = await x.service.prepare(x.id);
    await x.service.execute(
      x.id,
      { orderId: x.id, digest: p.digest, approved: true },
      key,
    );
    const message = getCompiledMessage(p.wire);
    if (bad === "message")
      message.recentBlockhash = blockhash(
        "SysvarC1ock11111111111111111111111111111111",
      );
    x.setReceipt({
      version: "legacy",
      transaction: { message, signatures: [x.service.row(x.id).signature] },
      meta: {
        err: bad === "failed" ? {} : null,
        fee: 5000n,
        preBalances: [100000000n, 0n, 1n],
        postBalances: [98995000n, bad === "amount" ? 1n : 1000000n, 1n],
      },
    });
    assert.equal((await x.service.reconcile(x.id)).state, "RECOVERY_REQUIRED");
    x.store.close();
  }
});
test("durable restart retains construction claim and refund/execution exclusion", () => {
  mkdirSync(".state/phase7b/tests", { recursive: true });
  const file = `.state/phase7b/tests/${randomUUID()}.sqlite`;
  let store = new Store(file);
  let service = new SolanaSettlement(store, setup().network, () => 100000);
  const q = setup().quote,
    id = service.quote(q).id;
  store.db
    .prepare(
      "UPDATE solana_settlement SET state='SIGNING',claimed=1 WHERE order_id=?",
    )
    .run(id);
  store.close();
  store = new Store(file);
  service = new SolanaSettlement(store, setup().network, () => 100000);
  assert.equal(service.view(id).state, "RECOVERY_REQUIRED");
  assert.throws(() => service.eligible(id));
  store.close();
});
