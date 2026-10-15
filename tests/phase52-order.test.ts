import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Phase52TestOrder } from "../services/validation/phase52-order.ts";
import { digest } from "../services/settlement/protocol.ts";
const now = 1800000000,
  id = "11111111-1111-4111-8111-111111111111",
  intent = {
    orderId: id,
    paymentRequestId: id,
    profileId: "profile",
    network: "zcash-testnet",
    zatoshis: "100000",
    recipient: "b",
    minimumConfirmations: 10,
    executionEnabled: false,
    purpose: "controlled-preconstruction-failure-refund-test",
  },
  review = {
    version: 1 as const,
    profileId: "profile",
    requestId: id,
    network: "zcash-testnet" as const,
    recipient: "b",
    zatoshis: "100000" as const,
    feeZatoshis: "10000",
    expiryHeight: 540,
    txid: "a".repeat(64),
    rawSha256: "b".repeat(64),
    rawBytes: 9166,
  };
const scan = {
  network: "zcash-testnet",
  account: "key",
  tip: 500,
  scanned: 500,
  observedAt: now,
  blockHash: "c".repeat(64),
  payments: [
    {
      txid: review.txid,
      zatoshis: "100000",
      height: 491,
      pool: 4,
      index: 0,
      blockHash: "d".repeat(64),
    },
  ],
};
function setup(db: DatabaseSync) {
  const order = new Phase52TestOrder(db, () => now);
  order.create(intent);
  order.prepared(id, review);
  return order;
}
test("test order requires approval and exact ten-confirmation scanner agreement", () => {
  const db = new DatabaseSync(":memory:"),
    o = setup(db);
  assert.throws(
    () => o.controlledRecovery(id, "key", scan, scan),
    /not_awaiting/,
  );
  assert.throws(() => o.approve(id, "wrong"));
  o.approve(id, digest(review));
  for (const s of [
    { ...scan, observedAt: now - 121 },
    { ...scan, blockHash: "d".repeat(64) },
    { ...scan, payments: [{ ...scan.payments[0], height: 492 }] },
    { ...scan, payments: [{ ...scan.payments[0], zatoshis: "99999" }] },
  ])
    assert.throws(() => o.controlledRecovery(id, "key", scan, s));
  assert.equal(o.view(id).state, "AWAITING_PAYMENT");
  db.close();
});
test("controlled recovery preserves an execution veto across duplicate processing and restart", () => {
  const file = join(
    mkdtempSync(join(tmpdir(), "phase52-order-")),
    "test.sqlite",
  );
  let db = new DatabaseSync(file),
    o = setup(db);
  o.approve(id, digest(review));
  o.controlledRecovery(id, "key", scan, scan);
  assert.equal(o.view(id).state, "RECOVERY_REQUIRED");
  assert.equal(o.view(id).executionBlocked, true);
  db.close();
  db = new DatabaseSync(file);
  o = new Phase52TestOrder(db, () => now);
  o.controlledRecovery(id, "key", scan, scan);
  assert.throws(() => o.assertExecutionAllowed(id), /execution_disabled/);
  assert.equal(o.view(id).refundBroadcastEnabled, false);
  db.close();
});
test("historical order databases and changed payment attribution are rejected", () => {
  const db = new DatabaseSync(":memory:"),
    o = setup(db);
  assert.throws(() => o.create({ ...intent, recipient: "other" }));
  assert.throws(() => o.prepared(id, { ...review, recipient: "other" }));
  db.close();
  const legacy = new DatabaseSync(":memory:");
  legacy.exec("CREATE TABLE orders(id TEXT)");
  assert.throws(() => new Phase52TestOrder(legacy), /isolated_order_database/);
  legacy.close();
});
