import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MainnetWatchJournal,
  validateMainnetWatchSnapshot,
  verifyOwnedNote,
  type MainnetOrderBinding,
  type MainnetWatchPayment,
  type MainnetWatchSnapshot,
} from "../services/settlement/mainnet-watch.js";

const now = 1_800_000_000;
const account = "a".repeat(64);
const address = "u1" + "q".repeat(60);
const tip = 100;
const blockHash = "b".repeat(64);

const payment = (
  over: Partial<MainnetWatchPayment> = {},
): MainnetWatchPayment => ({
  account,
  txid: "c".repeat(64),
  pool: 2,
  index: 0,
  zatoshis: "100000000",
  height: 90,
  blockHash: "d".repeat(64),
  address,
  memo: null,
  nullifier: "e".repeat(64),
  locked: false,
  spent: false,
  isChange: false,
  confirmations: 11,
  ...over,
});

const snapshot = (
  over: Partial<MainnetWatchSnapshot> = {},
): MainnetWatchSnapshot => ({
  network: "zcash-mainnet",
  watchOnly: true,
  liveChain: true,
  liveRefundsEnabled: false,
  source: "https://light.example.org",
  peerSource: "https://peer.example.org",
  account,
  address,
  birthday: 10,
  tip,
  scanned: tip,
  blockHash,
  observedAt: now,
  minimumConfirmations: 10,
  anchor: "f".repeat(64),
  anchorHeight: 91,
  checkpoint: null,
  payments: [],
  ...over,
});

const binding = (
  over: Partial<MainnetOrderBinding> = {},
): MainnetOrderBinding => ({
  orderId: "1".repeat(64),
  account,
  address,
  zatoshis: "100000000",
  expires: now + 600,
  ...over,
});

test("mainnet snapshot validation rejects testnet, stale and inconsistent scans", () => {
  validateMainnetWatchSnapshot(snapshot(), now);
  for (const bad of [
    snapshot({ network: "zcash-testnet" as never }),
    snapshot({ observedAt: now - 121 }),
    snapshot({ source: "https://testnet.zec.rocks" }),
    snapshot({ source: "https://peer.example.org" }),
    snapshot({ anchorHeight: 92 }),
    snapshot({ scanned: 99 }),
    snapshot({ payments: [payment({ confirmations: 10 })] }),
  ])
    assert.throws(() => validateMainnetWatchSnapshot(bad, now));
});

test("journal rejects metadata-only ownership while retaining attribution and reorg diagnostics", () => {
  const j = new MainnetWatchJournal(":memory:", () => now);
  const b = binding();
  assert.equal(j.observe(b, snapshot()).status, "awaiting");
  assert.equal(
    j.observe(b, snapshot({ minimumConfirmations: 20, payments: [payment()] }))
      .status,
    "invalid",
  );
  const confirmed = j.observe(b, snapshot({ payments: [payment()] }));
  assert.equal(confirmed.status, "invalid");
  assert.equal(confirmed.paymentDigest, null);
  assert.equal(
    j.observe(b, snapshot({ payments: [payment({ spent: true })] })).status,
    "invalid",
  );
  assert.equal(
    j.observe(
      b,
      snapshot({
        payments: [
          payment(),
          payment({ txid: "9".repeat(64), nullifier: "8".repeat(64) }),
        ],
      }),
    ).status,
    "ambiguous",
  );
});

test("matching metadata never proves cryptographic ownership", () => {
  const s = snapshot({ payments: [payment()] });
  assert.throws(
    () => verifyOwnedNote(s, binding(), s.payments[0]),
    /CRYPTOGRAPHIC_VERIFIER_REQUIRED/,
  );
  for (const p of [
    payment({ account: "9".repeat(64) }),
    payment({ address: "u1" + "p".repeat(60) }),
    payment({ nullifier: null }),
    payment({ spent: true }),
    payment({ height: 92 }),
  ])
    assert.throws(() =>
      verifyOwnedNote(snapshot({ payments: [p] }), binding(), p),
    );
});

test("payments are bound to one order and a reorg is detected against the checkpoint", () => {
  const j = new MainnetWatchJournal(":memory:", () => now);
  const a = binding(),
    b = binding({ orderId: "2".repeat(64) });
  assert.equal(
    j.observe(a, snapshot({ payments: [payment()] })).status,
    "invalid",
  );
  assert.throws(
    () => j.observe(b, snapshot({ payments: [payment()] })),
    /MAINNET_PAYMENT_REUSE_ACROSS_ORDERS/,
  );
  const checkpoint = {
    height: tip,
    hash: blockHash,
    orchardRoot: "7".repeat(64),
  };
  const next = j.observe(
    a,
    snapshot({
      tip: 101,
      scanned: 101,
      blockHash: "6".repeat(64),
      checkpoint,
      observedAt: now + 1,
      payments: [payment({ height: 90, confirmations: 12 })],
    }),
  );
  assert.equal(next.reorgDetected, false);
  const reorg = j.observe(
    a,
    snapshot({
      tip: 100,
      scanned: 100,
      blockHash,
      checkpoint: null,
      observedAt: now + 2,
      payments: [payment({ height: 90, confirmations: 11 })],
    }),
  );
  assert.equal(reorg.reorgDetected, true);
  assert.throws(
    () =>
      j.observe(
        a,
        snapshot({
          tip: 102,
          scanned: 102,
          blockHash: "5".repeat(64),
          checkpoint: null,
          observedAt: now + 3,
        }),
      ),
    /MAINNET_WATCH_CHECKPOINT_MISSING/,
  );
});

test("order binding is immutable and payment digest does not expose the nullifier", () => {
  const j = new MainnetWatchJournal(":memory:", () => now);
  j.bind(binding());
  j.bind(binding());
  assert.throws(() => j.bind(binding({ zatoshis: "2" })), /IMMUTABLE/);
  const result = j.observe(binding(), snapshot({ payments: [payment()] }));
  assert.notEqual(result.paymentDigest, payment().nullifier);
  assert.equal(result.paymentDigest, null);
  const publicStatus = j.status(binding().orderId);
  assert.equal(publicStatus.payments.length, 1);
  assert.equal("nullifier" in publicStatus.payments[0], false);
});

test("mutable SQLite status cannot turn metadata into an owned mainnet payment", () => {
  const j = new MainnetWatchJournal(":memory:", () => now);
  try {
    j.observe(binding(), snapshot({ payments: [payment()] }));
    j.db.prepare("UPDATE mainnet_watch_payments SET status='confirmed'").run();
    const status = j.status(binding().orderId);
    assert.equal(status.ownershipVerified, false);
    assert.equal(status.payments[0].status, "invalid");
    assert.throws(
      () =>
        verifyOwnedNote(
          snapshot({ payments: [payment()] }),
          binding(),
          payment(),
        ),
      /CRYPTOGRAPHIC_VERIFIER/,
    );
  } finally {
    j.close();
  }
});
