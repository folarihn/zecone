import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MainnetWatchJournal,
  MainnetWatchScanner,
  assertMainnetPaymentAuthorization,
  validateMainnetWatchSnapshot,
  verifyOwnedNote,
  type MainnetOrderBinding,
  type MainnetWatchObservation,
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
  ownershipEvidence: {
    scheme: "zcash-full-transaction-ufvk-v1",
    digest: "7".repeat(64),
    providers: 2,
  },
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

const liveNow = () => Math.floor(Date.now() / 1000);

async function nativeScan(s: MainnetWatchSnapshot) {
  const directory = mkdtempSync(join(tmpdir(), "zecone-mainnet-watch-")),
    script = join(directory, "snapshot.mjs");
  writeFileSync(
    script,
    `process.stdout.write(${JSON.stringify(JSON.stringify(s))});`,
  );
  return new MainnetWatchScanner(
    directory,
    s.source,
    s.peerSource,
    process.execPath,
    [script],
  ).observe();
}

function authorization(observation: MainnetWatchObservation) {
  return assertMainnetPaymentAuthorization(observation, {
    orderId: observation.orderId,
    paymentDigest: observation.paymentDigest!,
    zatoshis: "100000000",
  });
}

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
    assert.equal(status.payments[0].status, "verification-required");
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
test("rescanning invalidates the previously authorized observation", async () => {
  const t = liveNow(),
    b = binding({ expires: t + 600 }),
    j = new MainnetWatchJournal(":memory:", () => t);
  try {
    const first = j.observe(
      b,
      await nativeScan(snapshot({ observedAt: t, payments: [payment()] })),
    );
    assert.equal(first.status, "confirmed");
    assert.doesNotThrow(() => authorization(first));

    const second = j.observe(
      b,
      await nativeScan(snapshot({ observedAt: t, payments: [] })),
    );
    assert.equal(second.status, "awaiting");
    assert.throws(() => authorization(first), /AUTHORIZATION_REQUIRED/);
    assert.equal(j.status(b.orderId).ownershipVerified, false);
  } finally {
    j.close();
  }
});

test("closing the watch journal invalidates its outstanding grant", async () => {
  const t = liveNow(),
    b = binding({ expires: t + 600 }),
    j = new MainnetWatchJournal(":memory:", () => t),
    observation = j.observe(
      b,
      await nativeScan(snapshot({ observedAt: t, payments: [payment()] })),
    );
  assert.doesNotThrow(() => authorization(observation));
  j.close();
  assert.throws(() => authorization(observation), /AUTHORIZATION_REQUIRED/);
});

test("reorganization invalidates native payment evidence until a fresh confirmation", async () => {
  const t = liveNow(),
    b = binding({ expires: t + 600 }),
    j = new MainnetWatchJournal(":memory:", () => t);
  try {
    assert.equal(
      j.observe(b, await nativeScan(snapshot({ observedAt: t }))).status,
      "awaiting",
    );
    const confirmed = j.observe(
      b,
      await nativeScan(
        snapshot({
          observedAt: t,
          tip: 101,
          scanned: 101,
          blockHash: "6".repeat(64),
          checkpoint: {
            height: 100,
            hash: blockHash,
            orchardRoot: "7".repeat(64),
          },
          payments: [payment({ confirmations: 12 })],
        }),
      ),
    );
    assert.equal(confirmed.status, "confirmed");
    assert.doesNotThrow(() => authorization(confirmed));

    const reorg = j.observe(
      b,
      await nativeScan(
        snapshot({
          observedAt: t,
          tip: 100,
          scanned: 100,
          blockHash,
          checkpoint: null,
          payments: [payment()],
        }),
      ),
    );
    assert.equal(reorg.reorgDetected, true);
    assert.equal(reorg.status, "invalid");
    assert.equal(reorg.reason, "MAINNET_CHAIN_REORGANIZATION");
    assert.equal(reorg.paymentDigest, null);
    assert.throws(() => authorization(confirmed), /AUTHORIZATION_REQUIRED/);
    assert.throws(() => authorization(reorg), /AUTHORIZATION_REQUIRED/);
    assert.equal(j.status(b.orderId).ownershipVerified, false);
  } finally {
    j.close();
  }
});

test("restart cannot resurrect a native payment grant from the journal", async () => {
  const t = liveNow(),
    b = binding({ expires: t + 600 }),
    path = join(
      mkdtempSync(join(tmpdir(), "zecone-mainnet-watch-db-")),
      "watch.sqlite",
    ),
    first = new MainnetWatchJournal(path, () => t),
    observation = first.observe(
      b,
      await nativeScan(snapshot({ observedAt: t, payments: [payment()] })),
    );
  assert.doesNotThrow(() => authorization(observation));
  first.close();

  const restarted = new MainnetWatchJournal(path, () => t);
  try {
    const status = restarted.status(b.orderId);
    assert.equal(status.ownershipVerified, false);
    assert.equal(status.payments[0].status, "verification-required");
    assert.throws(() => authorization(observation), /AUTHORIZATION_REQUIRED/);
  } finally {
    restarted.close();
  }
});

test("fabricated payment objects and mutable observations cannot gain authority", async () => {
  const t = liveNow(),
    b = binding({ expires: t + 600 }),
    native = await nativeScan(
      snapshot({ observedAt: t, payments: [payment()] }),
    );
  assert.ok(Object.isFrozen(native));
  assert.ok(Object.isFrozen(native.payments[0]));
  assert.ok(Object.isFrozen(native.payments[0].ownershipEvidence));
  assert.throws(
    () =>
      verifyOwnedNote(native, b, {
        ...native.payments[0],
        txid: "9".repeat(64),
      }),
    /CRYPTOGRAPHIC_VERIFIER_REQUIRED/,
  );
  assert.throws(
    () => verifyOwnedNote(structuredClone(native), b, native.payments[0]),
    /CRYPTOGRAPHIC_VERIFIER_REQUIRED/,
  );

  const j = new MainnetWatchJournal(":memory:", () => t);
  try {
    const observation = j.observe(b, native);
    assert.ok(Object.isFrozen(observation));
    assert.throws(() => {
      (observation as { paymentDigest: string | null }).paymentDigest = null;
    }, TypeError);
    assert.doesNotThrow(() => authorization(observation));
  } finally {
    j.close();
  }
});
test("a rejected rescan clears the previous grant instead of leaving it live", async () => {
  const t = liveNow(),
    b = binding({ expires: t + 600 }),
    j = new MainnetWatchJournal(":memory:", () => t);
  try {
    const observation = j.observe(
      b,
      await nativeScan(snapshot({ observedAt: t, payments: [payment()] })),
    );
    assert.doesNotThrow(() => authorization(observation));
    assert.throws(
      () => j.observe(b, snapshot({ observedAt: t, scanned: 99 })),
      /INVALID_MAINNET_WATCH_SNAPSHOT/,
    );
    assert.throws(() => authorization(observation), /AUTHORIZATION_REQUIRED/);
    assert.equal(j.status(b.orderId).ownershipVerified, false);
  } finally {
    j.close();
  }
});
