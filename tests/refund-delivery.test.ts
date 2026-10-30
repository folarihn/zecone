import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../services/settlement/protocol.ts";
import {
  SimulatedRefundDelivery,
  type SimulationReceipt,
  type SimulationTransport,
} from "../services/settlement/refund-delivery-simulation.ts";
const now = 1800000000,
  a = {
    refundId: "test-refund",
    orderId: "test-order",
    requestDigest: "a".repeat(64),
    txid: "b".repeat(64),
    rawHex: "ab12",
    destination: "synthetic-destination",
    zatoshis: "90000",
  };
function setup() {
  let sends = 0,
    receipt: SimulationReceipt | null = null,
    fail = false;
  const path = join(
      mkdtempSync(join(tmpdir(), "zecone-refund-simulation-")),
      "test.sqlite",
    );
  const db = new DatabaseSync(path);
  const t: SimulationTransport = {
    simulation: true,
    async sendExact(raw) {
      assert.equal(raw, a.rawHex);
      sends++;
      if (fail) throw Error("lost response");
      return a.txid;
    },
    async receipt() {
      return receipt;
    },
  };
  const d = new SimulatedRefundDelivery(db, t, () => now);
  d.prepare(a, digest(a));
  return {
    path,
    db,
    t,
    d,
    get sends() {
      return sends;
    },
    fail() {
      fail = true;
    },
    receipt(v: SimulationReceipt | null) {
      receipt = v;
    },
  };
}
const evidence = (depth = 10): SimulationReceipt => ({
  network: "zcash-testnet",
  txid: a.txid,
  destination: a.destination,
  zatoshis: a.zatoshis,
  tip: 100 + depth - 1,
  minedHeight: 100,
  blockHash: "c".repeat(64),
  observedAt: now,
});
test("exact approval, unique order and duplicate concurrent broadcast protections", async () => {
  const f = setup();
  try {
    assert.throws(() =>
      f.d.prepare(
        { ...a, refundId: "other" },
        digest({ ...a, refundId: "other" }),
      ),
    );
    assert.throws(
      () =>
        f.d.prepare({ ...a, rawHex: "cd12" }, digest({ ...a, rawHex: "cd12" })),
      /replay/,
    );
    const results = await Promise.allSettled([
      f.d.simulateBroadcast(a.refundId),
      f.d.simulateBroadcast(a.refundId),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.sends, 1);
    assert.throws(() => f.d.broadcast(), /disabled/);
  } finally {
    f.db.close();
  }
});
test("lost broadcast response survives restart and never triggers another send", async () => {
  const f = setup();
  let current=f.db;
  try {
    f.fail();
    await assert.rejects(f.d.simulateBroadcast(a.refundId), /uncertain/);
    f.db.close();current=new DatabaseSync(f.path);
    const restarted = new SimulatedRefundDelivery(current, f.t, () => now);
    await assert.rejects(
      restarted.simulateBroadcast(a.refundId),
      /reconcile_only/,
    );
    f.receipt(evidence());
    await restarted.reconcile(a.refundId);
    assert.equal(restarted.view(a.refundId).state, "REFUNDED");
    assert.equal(f.sends, 1);
    assert.equal(restarted.view(a.refundId).executionBlocked, true);
    assert.equal(restarted.view(a.refundId).liveRefundConfirmed, false);
  } finally {
    current.close();
  }
});
test("nine confirmations, stale evidence, wrong destination and reorg never authorize replacement", async () => {
  const f = setup();
  try {
    await f.d.simulateBroadcast(a.refundId);
    f.receipt(evidence(9));
    await f.d.reconcile(a.refundId);
    assert.equal(f.d.view(a.refundId).state, "CONFIRMING");
    for (const e of [
      { ...evidence(), observedAt: now - 121 },
      { ...evidence(), destination: "attacker" },
      { ...evidence(), zatoshis: "1" },
    ]) {
      f.receipt(e);
      await assert.rejects(f.d.reconcile(a.refundId));
      assert.equal(f.d.view(a.refundId).state, "RECOVERY_REQUIRED");
    }
    f.receipt(evidence());
    await f.d.reconcile(a.refundId);
    f.receipt(null);
    await f.d.reconcile(a.refundId);
    assert.equal(f.d.view(a.refundId).state, "RECOVERY_REQUIRED");
    await assert.rejects(f.d.simulateBroadcast(a.refundId));
    assert.equal(f.sends, 1);
  } finally {
    f.db.close();
  }
});
test("crash after transport acknowledgment before persistence retains uncertain claim", async () => {
  const f = setup();
  try {
    f.db.exec(
      "CREATE TRIGGER crash_ack BEFORE UPDATE ON simulated_refund_delivery WHEN NEW.state='BROADCAST' BEGIN SELECT RAISE(ABORT,'crash'); END;",
    );
    await assert.rejects(f.d.simulateBroadcast(a.refundId), /uncertain/);
    assert.equal(f.d.row(a.refundId)?.state, "BROADCAST_UNCERTAIN");
    f.db.exec("DROP TRIGGER crash_ack");
    f.receipt(evidence());
    await f.d.reconcile(a.refundId);
    assert.equal(f.d.view(a.refundId).state, "REFUNDED");
    assert.equal(f.sends, 1);
  } finally {
    f.db.close();
  }
});
