// Synthetic Zcash snapshots and injected EVM failures only. Never live-payment evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { PurchaseJournal } from "../services/marketplace/journal.ts";
import { Purchases } from "../services/marketplace/service.ts";
import {
  GAS_BUDGET,
  RATE,
  marketAbi,
  terms,
  purchaseTyped,
  validateSignature,
  type UnsignedPurchase,
  type PurchaseBase,
} from "../services/marketplace/purchase.ts";
import type { Snapshot } from "../services/execution/store.ts";
import type { Session } from "../services/wallet/security.ts";
import { Dapps } from "../services/wallet/dapps.ts";
import { locked } from "../services/execution/io.ts";
const hex = () => toHex(randomBytes(32)),
  address = () => privateKeyToAccount(generatePrivateKey()).address,
  now = () => Math.floor(Date.now() / 1000);
const session: Session = {
  id: "local",
  csrf: "f".repeat(64),
  connected: 1,
  expires: Date.now() + 3600000,
};

test("approved quote waits for a competing scan lock and reuses its signed identity", async () => {
  const f = await fixture();
  try {
    const competing = locked(f.service.lockPath, async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    await f.service.attach(f.store.row(f.id)!, f.signed);
    await competing;
    assert.equal(f.store.row(f.id)!.order_id, f.digest);
    assert.equal(f.store.all().length, 1);
  } finally {
    f.close();
  }
});
test("sent payment without a mined note is pending mining, never a payment request or completion", async () => {
  const f = await fixture();
  try {
    assert.equal(
      f.service.view(f.store.row(f.id)!).status,
      "Payment sent — awaiting mining",
    );
    assert.equal(f.service.view(f.store.row(f.id)!).ownerVerified, false);
  } finally {
    f.close();
  }
});
test("two service instances cannot concurrently settle one confirmed purchase twice", async () => {
  const f = await fixture();
  const secondStore = new PurchaseJournal(f.path);
  try {
    const second = new Purchases(
      secondStore,
      f.service.manifest,
      f.service.scanner,
    );
    second.available = () => true;
    second.base = () => f.service.base();
    second.config = () => f.config;
    second.lockPath = f.service.lockPath;
    second.legacyPath = f.service.legacyPath;
    await Promise.all([f.service.tick(), second.tick()]);
    await second.tick();
    assert.deepEqual(f.counts(), { prepares: 1, broadcasts: 1 });
  } finally {
    secondStore.close();
    f.close();
  }
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "zecone-purchase-")),
    path = join(dir, "purchase.sqlite"),
    store = new PurchaseJournal(path),
    user = privateKeyToAccount(generatePrivateKey()),
    config = {
      executor: address(),
      marketplace: address(),
      nft: address(),
      origin: "http://127.0.0.1:4322",
    },
    orderId = hex(),
    id = randomUUID();
  const intent: UnsignedPurchase = {
    kind: "purchase",
    chainId: 84532,
    contract: config.executor,
    marketplace: config.marketplace,
    nft: config.nft,
    orderId,
    nonce: orderId,
    listingId: "1",
    tokenId: "1",
    recipient: user.address,
    seller: address(),
    price: "100000000000000",
    gasBudget: GAS_BUDGET.toString(),
    rate: RATE.toString(),
    maxSlippageBps: "0",
    zatoshis: "1000000",
    expiry: now() + 3500,
    calldataHash: keccak256(
      encodeFunctionData({
        abi: marketAbi,
        functionName: "buy",
        args: [1n, user.address],
      }),
    ),
    refundHash: hex(),
    originHash: keccak256(toHex(config.origin)),
  };
  const signed = {
      ...intent,
      signature: await user.signTypedData(purchaseTyped(intent)),
    },
    digest = await validateSignature(signed, config, user.address, now()),
    account = randomUUID();
  store.reserve(
    id,
    config.origin,
    session.id,
    intent,
    "utest-SYNTHETIC-REFUND",
    randomUUID(),
    10n ** 18n,
    now(),
  );
  store.create(digest, signed, account, "utest-SYNTHETIC-RECEIVER", now());
  store.db
    .prepare("UPDATE purchase_requests SET order_id=?,stage='sent' WHERE id=?")
    .run(digest, id);
  const snapshot: Snapshot = {
    network: "zcash-testnet",
    tip: 100,
    scanned: 100,
    observedAt: now(),
    payments: [
      {
        account,
        txid: hex().slice(2),
        pool: 4,
        index: 0,
        zatoshis: intent.zatoshis,
        height: 91,
        blockHash: hex().slice(2),
      },
    ],
  };
  let prepares = 0,
    broadcasts = 0,
    fail = "",
    lost = false,
    balance = 10n ** 18n,
    result: any = { status: "pending" };
  const raw = hex(),
    hash = keccak256(raw);
  const fake = {
    account: { address: address() },
    public: { getBalance: async () => balance },
    check: async () => {},
    validate: async () => digest,
    prepare: async () => {
      prepares++;
      if (fail) throw Error(fail);
      return { raw, hash };
    },
    broadcast: async () => {
      broadcasts++;
      if (lost) throw Error("lost response");
      return hash;
    },
    receipt: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as PurchaseBase;
  const service = new Purchases(
    store,
    {
      base: { user: user.address },
      zcash: { payer: { account: "payer", address: "utest-SYNTHETIC-REFUND" } },
    },
    {
      allocate: async () => ({ account, address: "utest-SYNTHETIC-RECEIVER" }),
      observe: async () => ({ ...snapshot, observedAt: now() }),
    },
  );
  service.available = () => true;
  service.config = () => config;
  service.base = () => fake;
  service.lockPath = join(dir, "lock");
  service.legacyPath = join(dir, "old.sqlite");
  return {
    dir,
    path,
    store,
    service,
    user,
    config,
    intent,
    signed,
    digest,
    id,
    snapshot,
    hash,
    setFail: (v: string) => (fail = v),
    setLost: () => (lost = true),
    setBalance: (v: bigint) => (balance = v),
    setResult: (v: any) => (result = v),
    counts: () => ({ prepares, broadcasts }),
    close: () => store.close(),
  };
}
test("purchase terms and signature bind origin, chain, recipient, NFT, calldata, rate and expiry", async () => {
  const f = await fixture();
  try {
    for (const change of [
      { chainId: 8453 },
      { recipient: address() },
      { nft: address() },
      { marketplace: address() },
      { contract: address() },
      { calldataHash: hex() },
      { rate: "1" },
      { gasBudget: "0" },
      { maxSlippageBps: "1" },
      { zatoshis: "1" },
      { expiry: now() - 1 },
      { originHash: hex() },
    ])
      assert.throws(() =>
        terms(
          { ...f.intent, ...change } as UnsignedPurchase,
          f.config,
          f.user.address,
          now(),
        ),
      );
    await assert.rejects(
      validateSignature(
        {
          ...f.signed,
          signature: await privateKeyToAccount(
            generatePrivateKey(),
          ).signTypedData(purchaseTyped(f.intent)),
        },
        f.config,
        f.user.address,
        now(),
      ),
    );
  } finally {
    f.close();
  }
});
test("reservations survive restart and prevent duplicate listings and overcommitted liquidity", async () => {
  const f = await fixture();
  try {
    assert.throws(() =>
      f.store.reserve(
        randomUUID(),
        f.config.origin,
        "s",
        f.intent,
        "refund",
        randomUUID(),
        10n ** 18n,
        now(),
      ),
    );
    const second = new PurchaseJournal(f.path);
    try {
      assert.throws(
        () =>
          second.reserve(
            randomUUID(),
            f.config.origin,
            "s",
            { ...f.intent, listingId: "2" },
            "refund",
            randomUUID(),
            f.store.reserved(),
            now(),
          ),
        /liquidity/,
      );
      assert.equal(second.row(f.id)!.refund, "utest-SYNTHETIC-REFUND");
    } finally {
      second.close();
    }
  } finally {
    f.close();
  }
});
test("nine confirmations, underpayments, and reorg before authorization never broadcast", async () => {
  const f = await fixture();
  try {
    f.snapshot.payments[0].height = 92;
    await f.service.tick();
    assert.equal(f.counts().broadcasts, 0);
    f.snapshot.payments[0].height = 91;
    f.snapshot.payments[0].zatoshis = "999999";
    await f.service.tick();
    assert.equal(f.counts().broadcasts, 0);
    f.snapshot.payments = [];
    await f.service.tick();
    assert.equal(f.counts().broadcasts, 0);
  } finally {
    f.close();
  }
});
test("duplicate confirmed outputs settle once; restart and repeated tick cannot repay", async () => {
  const f = await fixture();
  try {
    f.snapshot.payments.push({ ...f.snapshot.payments[0] });
    await f.service.tick();
    assert.equal(f.store.totals(f.digest).confirmed, 1000000n);
    f.setResult({
      status: "success",
      hash: f.hash,
      block: "1",
      recipient: f.user.address,
      tokenId: "1",
    });
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.store.get(f.digest)!.state, "settled");
    assert.equal(f.store.reserved(), 0n);
    const reopened = new PurchaseJournal(f.path);
    assert.equal(reopened.get(f.digest)!.state, "settled");
    reopened.close();
    assert.deepEqual(f.counts(), { prepares: 1, broadcasts: 1 });
  } finally {
    f.close();
  }
});
for (const reason of [
  "listing_sold",
  "listing_cancelled",
  "listing_expired",
  "listing_changed",
  "seller_ownership_changed",
  "seller_approval_revoked",
  "gas_budget_exceeded",
])
  test(`confirmed payment plus ${reason} preserves refund recovery`, async () => {
    const f = await fixture();
    try {
      f.setFail(reason);
      await f.service.tick();
      await f.service.tick();
      assert.equal(f.counts().broadcasts, 0);
      assert.equal(f.store.get(f.digest)!.state, "recovery");
      assert.equal((f.store.report().recoveries[0] as any).reason, reason);
      assert.equal(f.store.row(f.id)!.refund, "utest-SYNTHETIC-REFUND");
      assert.equal(f.counts().prepares, 1);
    } finally {
      f.close();
    }
  });
test("insufficient provider liquidity fails closed after confirmed payment", async () => {
  const f = await fixture();
  try {
    f.setBalance(0n);
    await f.service.tick();
    assert.equal(f.counts().broadcasts, 0);
    assert.equal(
      (f.store.report().recoveries[0] as any).reason,
      "insufficient_provider_liquidity",
    );
  } finally {
    f.close();
  }
});
test("ambiguous broadcast retains exact hash, never retries, and reconciles receipt", async () => {
  const f = await fixture();
  try {
    f.setLost();
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.counts().broadcasts, 1);
    assert.equal(f.store.get(f.digest)!.tx_hash, f.hash);
    f.setResult({
      status: "success",
      hash: f.hash,
      block: "1",
      recipient: f.user.address,
      tokenId: "1",
    });
    await f.service.tick();
    assert.equal(f.store.get(f.digest)!.state, "settled");
    assert.equal(f.counts().broadcasts, 1);
  } finally {
    f.close();
  }
});
test("confirmed revert and ownership mismatch require recovery with no automatic retry", async () => {
  for (const result of [{ status: "reverted" }, Error("wrong owner")]) {
    const f = await fixture();
    try {
      await f.service.tick();
      f.setResult(result);
      await f.service.tick();
      await f.service.tick();
      assert.equal(f.service.view(f.store.row(f.id)!).manualRecovery, true);
      assert.equal(f.counts().broadcasts, 1);
    } finally {
      f.close();
    }
  }
});
test("expired paid order, overpayment, and post-authorization reorg are auditable", async () => {
  const f = await fixture();
  try {
    f.snapshot.payments.push({
      ...f.snapshot.payments[0],
      index: 1,
      zatoshis: "1",
    });
    await f.service.tick();
    assert.equal(
      (f.store.report().recoveries[0] as any).reason,
      "excess_payment",
    );
    f.snapshot.payments = [];
    await f.service.tick();
    assert.ok(
      f.store
        .report()
        .recoveries.some(
          (r: any) => r.reason === "payment_reorg_after_authorization",
        ),
    );
    assert.equal(f.counts().broadcasts, 1);
  } finally {
    f.close();
  }
  const g = await fixture();
  try {
    g.store.db
      .prepare("UPDATE orders SET intent=? WHERE id=?")
      .run(JSON.stringify({ ...g.signed, expiry: now() - 1 }), g.digest);
    await g.service.tick();
    assert.equal(g.counts().broadcasts, 0);
    assert.ok(
      g.store
        .report()
        .recoveries.some((r: any) => r.reason === "expired_payment"),
    );
  } finally {
    g.close();
  }
});
test("public purchase projection excludes payment keys, notes, amounts, and refund destination", async () => {
  const f = await fixture();
  try {
    const projection = f.service.externalStatus(f.config.origin, f.id);
    for (const key of [
      "refundDestination",
      "paymentTx",
      "fee",
      "zatoshis",
      "receivedZatoshis",
      "confirmations",
      "signature",
    ])
      assert.equal(key in projection, false);
    assert.throws(() =>
      f.service.externalStatus("https://other.example", f.id),
    );
  } finally {
    f.close();
  }
});
test("interrupted native send requires reconciliation and cannot initiate another payment", async () => {
  const f = await fixture();
  try {
    f.store.stage(f.id, "sending");
    const restarted = new Purchases(f.store, {
      base: { user: f.user.address },
      zcash: { payer: { account: "payer", address: "refund" } },
    });
    assert.equal(f.store.row(f.id)!.stage, "review");
    let sends = 0;
    restarted.native = async () => {
      sends++;
      throw Error("must not send");
    };
    await restarted.pay(session, f.id, randomUUID(), true);
    assert.equal(sends, 0);
  } finally {
    f.close();
  }
});
test("dApp purchase requests require origin permission, exact approval, and revocation blocks status", async () => {
  const f = await fixture();
  const d = new Dapps(f.user.address, join(f.dir, "dapps.sqlite"), f.service);
  try {
    const request = {
      id: randomUUID(),
      channel: randomUUID(),
      origin: f.config.origin,
      method: "zecone_getPurchaseStatus",
      params: [f.id],
    };
    await assert.rejects(d.request(session, request));
    d.db
      .prepare("INSERT INTO permissions VALUES(?,?)")
      .run(f.config.origin, Date.now());
    const response = await d.request(session, request);
    assert.equal(response.done, true);
    d.revoke(f.config.origin);
    await assert.rejects(d.request(session, { ...request, id: randomUUID() }));
  } finally {
    d.db.close();
    f.close();
  }
});
