import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  SignerRecoveryRegistry,
  WatchRefundReader,
  validateWatchSnapshot,
  type WatchSnapshot,
  type RecoveryRegistration,
} from "../services/signer/watch-evidence.ts";
import { digest } from "../services/settlement/protocol.ts";
import { IsolatedNativeRefundSigner } from "../services/signer/native-refund.ts";
import { Store } from "../services/execution/store.ts";
// Synthetic boundary cases only. Real chain results live in the separate proof report.
const now = 1800000000,
  orderId = `0x${"a".repeat(64)}`;
function fixture(): WatchSnapshot {
  const p = {
    account: "b".repeat(64),
    txid: "c".repeat(64),
    pool: 4,
    index: 0,
    zatoshis: "1000000",
    height: 101,
    blockHash: "d".repeat(64),
  };
  return {
    network: "zcash-testnet",
    watchOnly: true,
    liveChain: true,
    liveRefundsEnabled: false,
    source: "https://testnet.zec.rocks:443",
    account: p.account,
    address: "test-only-placeholder",
    birthday: 90,
    tip: 110,
    scanned: 110,
    blockHash: "e".repeat(64),
    observedAt: now,
    payments: [p],
    native: {
      fullViewingKey: "f".repeat(192),
      anchor: "1".repeat(64),
      anchorHeight: 101,
      inputs: [
        {
          nullifier: "2".repeat(64),
          zatoshis: p.zatoshis,
          minedHeight: 101,
          paymentKey: `${p.txid}:4:0`,
        },
      ],
    },
  };
}
function setup(s = fixture()) {
  const db = new DatabaseSync(":memory:"),
    registry = new SignerRecoveryRegistry(db);
  const r: RecoveryRegistration = {
    orderId,
    account: s.account,
    intent: { recipient: `0x${"3".repeat(40)}`, purpose: "synthetic" },
    destination: "test-only-placeholder",
    orderState: "recovery",
    execution: "never-constructed",
    reviewedAt: now,
    expiresAt: now + 3600,
  };
  registry.register(r, digest(r), now);
  const reader = new WatchRefundReader(
    {
      async observe() {
        return structuredClone(s);
      },
    },
    registry,
    () => now,
  );
  return { s, r, reader, registry, db };
}
test("independent reader recomputes confirmed payment digest and native evidence", async () => {
  const { s, r, reader, db } = setup();
  try {
    const e = await reader.read(orderId);
    assert.equal(e.eligibleZatoshis, "1000000");
    assert.equal(e.minimumConfirmations, 10);
    assert.equal(e.intentDigest, digest(r.intent));
    assert.equal(
      e.paymentDigest,
      digest([
        {
          key: `${s.payments[0].txid}:4:0`,
          zatoshis: "1000000",
          height: 101,
          block_hash: s.payments[0].blockHash,
        },
      ]),
    );
    const n = await reader.readNative(orderId);
    assert.equal(n.anchor, s.native.anchor);
    assert.equal(n.inputs.length, 1);
    assert.ok(!("paymentKey" in n.inputs[0]));
  } finally {
    db.close();
  }
});
test("unfunded, nine confirmations, spent inputs and mixed pools fail closed", async () => {
  for (const mutate of [
    (s: WatchSnapshot) => {
      s.payments = [];
      s.native.inputs = [];
    },
    (s: WatchSnapshot) => {
      s.tip = 109;
      s.scanned = 109;
    },
    (s: WatchSnapshot) => {
      s.native.inputs = [];
    },
    (s: WatchSnapshot) => {
      s.payments[0].pool = 3;
      s.native.inputs = [];
    },
  ]) {
    const x = setup();
    try {
      mutate(x.s);
      await assert.rejects(x.reader.read(orderId));
      await assert.rejects(x.reader.readNative(orderId));
    } finally {
      x.db.close();
    }
  }
});
test("malformed, stale, duplicate, wrong account and changed native note evidence rejected", () => {
  for (const mutate of [
    (s: WatchSnapshot) => {
      s.observedAt = now - 121;
    },
    (s: WatchSnapshot) => {
      s.scanned--;
    },
    (s: WatchSnapshot) => {
      s.network = "mainnet";
    },
    (s: WatchSnapshot) => {
      s.payments.push({ ...s.payments[0] });
    },
    (s: WatchSnapshot) => {
      s.payments[0].account = "0".repeat(64);
    },
    (s: WatchSnapshot) => {
      s.native.inputs[0].zatoshis = "2";
    },
    (s: WatchSnapshot) => {
      s.native.inputs.push({ ...s.native.inputs[0] });
    },
    (s: WatchSnapshot) => {
      s.native.anchor = "invalid";
    },
  ]) {
    const s = fixture();
    mutate(s);
    assert.throws(() => validateWatchSnapshot(s, now));
  }
});
test("registry requires explicit review, immutable order/account binding and expiry", async () => {
  const x = setup();
  try {
    assert.throws(() =>
      x.registry.register({ ...x.r, destination: "changed" }, digest(x.r), now),
    );
    const changed = { ...x.r, destination: "changed" };
    assert.throws(
      () => x.registry.register(changed, digest(changed), now),
      /immutable/,
    );
    const other = { ...x.r, orderId: `0x${"9".repeat(64)}` };
    assert.throws(() => x.registry.register(other, digest(other), now));
    assert.throws(() => x.registry.read(orderId, now + 3600), /expired/);
    await assert.rejects(x.reader.read("unknown"), /not_registered/);
    x.s.account = "9".repeat(64);
    x.s.payments[0].account = x.s.account;
    await assert.rejects(x.reader.read(orderId), /account_mismatch/);
  } finally {
    x.db.close();
  }
});
test("real-chain source is blocked before any native signing or vault access", async () => {
  // Call the actual method with deliberately absent signer/vault fields; gate must run first.
  await assert.rejects(
    IsolatedNativeRefundSigner.prototype.sign.call(
      { reader: { liveChain: true } } as any,
      {} as any,
      Buffer.alloc(0),
      {} as any,
      "",
    ),
    /separate_device_validation_required/,
  );
});
test("changed receipt set between authorization review and native scan is rejected before IPC", async () => {
  await assert.rejects(
    IsolatedNativeRefundSigner.prototype.review.call(
      {
        reviewer: { async review() {} },
        reader: {
          liveChain: true,
          async readNative() {
            return { paymentDigest: "changed" };
          },
        },
      } as any,
      { request: { orderId, paymentDigest: "approved" } } as any,
      Buffer.alloc(0),
    ),
    /payment_set_changed/,
  );
});
test("watch snapshots feed durable settlement observation and reorg removal without spending keys", () => {
  const s = fixture(),
    store = new Store(":memory:", 10);
  try {
    const intent = {
      nonce: `0x${"4".repeat(64)}`,
      recipient: `0x${"3".repeat(40)}`,
      zatoshis: "1000000",
      expiry: now + 3600,
    };
    store.create(orderId as any, intent as any, s.account, s.address, now);
    store.observe(s, now);
    assert.equal(store.get(orderId)?.state, "verified");
    assert.equal(store.totals(orderId).confirmed, 1000000n);
    s.payments = [];
    s.native.inputs = [];
    store.observe(s, now);
    assert.equal(store.totals(orderId).confirmed, 0n);
    assert.equal(store.get(orderId)?.state, "awaiting_payment");
  } finally {
    store.close();
  }
});
