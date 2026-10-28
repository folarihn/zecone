// Restricted public mainnet pilot: the public API (no viewing key) is fed by the
// operator-side sync, which runs the existing watcher bridge over a local mirror.
// Synthetic chain through the real scanner code; Base verification is injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPERATOR_TOKEN,
  newWallet,
  onboard,
  startHarness,
} from "./helpers/payments-harness.ts";
import { fakeWatcher, type FakeChain } from "./helpers/fake-watcher.ts";
import { DEFAULT_CHECKOUT_ADDRESS } from "../services/payments/api.ts";
import { PaymentStore } from "../services/payments/store.ts";
import { PaymentWatchBridge } from "../services/payments/watch-bridge.ts";
import type { BasePayoutCheck } from "../services/payments/operator-feed.ts";
import { httpRemote, syncOnce } from "../scripts/operator-sync.ts";

const ADDR = DEFAULT_CHECKOUT_ADDRESS;
const realNow = () => Math.floor(Date.now() / 1000);
const tx = (c: string) => c.repeat(64);
const BASE_TX = "0x" + "9".repeat(64);
const genesis = (): FakeChain => ({
  tip: 1000,
  hashes: { 1000: "0".repeat(60) + "1000" },
  notes: [],
  defaultAddress: ADDR,
});

async function pilotHarness(check: BasePayoutCheck) {
  const pilotWallet = newWallet();
  const h = await startHarness({
    mode: "monitor",
    now: realNow,
    monitor: {
      authorized: true,
      source: "operator",
      minimumConfirmations: 20,
      intervalSeconds: 3600,
    },
    pilot: {
      merchantOwner: pilotWallet.address,
      maxAmountUsd: "1.00",
      maxPayoutWei: 10n ** 15n,
      payout: check,
    },
    operatorListenerOnly: true,
  });
  const op: Server = createServer(
    (req, res) => void h.app.handleOperator(req, res),
  );
  await new Promise<void>((r) => op.listen(0, "127.0.0.1", () => r()));
  const opBase = `http://127.0.0.1:${(op.address() as AddressInfo).port}/`;
  const dir = mkdtempSync(join(tmpdir(), "zecone-mirror-"));
  const mirror = new PaymentStore(join(dir, "mirror.sqlite"));
  const w = fakeWatcher(genesis());
  const bridge = new PaymentWatchBridge(mirror, w.scanner, {
    receivingAddress: ADDR,
    minimumConfirmations: 20,
    now: realNow,
  });
  const remote = httpRemote(opBase, OPERATOR_TOKEN);
  return {
    h,
    w,
    mirror,
    bridge,
    remote,
    pilotWallet,
    opBase,
    async close() {
      await new Promise<void>((r) => op.close(() => r()));
      mirror.close();
      rmSync(dir, { recursive: true, force: true });
      await h.close();
    },
  };
}

test("public pilot: only the approved merchant gets real orders; demo stays simulated", async () => {
  const t = await pilotHarness({
    verify: async () => assert.fail("no payout"),
  });
  try {
    const demo = await t.h.call("/api/v1/payments", {
      body: { amountUsd: "5.00" },
    });
    assert.equal(demo.status, 201);
    assert.equal(demo.body.payment.mode, "demo");
    assert.equal(demo.body.payment.zcashAddress, null);

    const other = await onboard(t.h);
    const refused = await t.h.call("/api/v1/payments", {
      key: other.apiKey,
      body: { amountUsd: "0.01" },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "real_payments_restricted");

    const pilot = await onboard(t.h, t.pilotWallet);
    // No verified watcher heartbeat yet: real checkouts are paused.
    assert.equal(
      (
        await t.h.call("/api/v1/payments", {
          key: pilot.apiKey,
          body: { amountUsd: "0.01" },
        })
      ).body.error.code,
      "watcher_not_ready",
    );
    assert.equal((await syncOnce(t.mirror, t.bridge, t.remote)).ok, true);
    assert.equal(
      (
        await t.h.call("/api/v1/payments", {
          key: pilot.apiKey,
          body: { amountUsd: "1.01" },
        })
      ).body.error.code,
      "amount_too_large",
    );
    const real = await t.h.call("/api/v1/payments", {
      key: pilot.apiKey,
      body: { amountUsd: "0.01" },
    });
    assert.equal(real.status, 201);
    assert.equal(real.body.payment.mode, "monitor");
    assert.equal(real.body.payment.simulated, false);
    assert.equal(real.body.payment.zcashAddress, ADDR);
    assert.equal(real.body.payment.settlement, "operator-approved");
    // One active checkout on the shared address.
    assert.equal(
      (
        await t.h.call("/api/v1/payments", {
          key: pilot.apiKey,
          body: { amountUsd: "0.01" },
        })
      ).body.error.code,
      "checkout_busy",
    );

    const health = (await t.h.call("/api/v1/health", { key: null })).body;
    assert.equal(health.realPayments, "restricted-pilot");
    assert.equal(health.livePayoutEnabled, false);
    assert.equal(health.watcher.tip, 1000);
  } finally {
    await t.close();
  }
});

test("public pilot: operator routes are never served on the public listener", async () => {
  const t = await pilotHarness({
    verify: async () => assert.fail("no payout"),
  });
  try {
    for (const headers of [{}, { "X-Forwarded-For": "203.0.113.9" }] as Record<
      string,
      string
    >[]) {
      const r = await t.h.call("/api/v1/operator/real-orders", {
        key: OPERATOR_TOKEN,
        headers,
      });
      assert.equal(r.status, 404);
    }
    const bad = httpRemote(t.opBase, "wrong-token-wrong-token-wrong-token-x");
    await assert.rejects(bad.orders(), /REMOTE_NOT_FOUND/);
  } finally {
    await t.close();
  }
  // Without a dedicated listener, a proxied request from loopback is still not an operator call.
  const h = await startHarness();
  try {
    assert.equal(
      (await h.call("/api/v1/operator/unattributed", { key: OPERATOR_TOKEN }))
        .status,
      200,
    );
    assert.equal(
      (
        await h.call("/api/v1/operator/unattributed", {
          key: OPERATOR_TOKEN,
          headers: { "X-Forwarded-For": "203.0.113.9" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await h.call("/api/v1/operator/unattributed", {
          key: OPERATOR_TOKEN,
          headers: { "X-Real-IP": "203.0.113.9" },
        })
      ).status,
      404,
    );
  } finally {
    await h.close();
  }
});

test("public pilot: deposit → confirmations → ZEC_CONFIRMED → verified Base payout → receipt", async () => {
  const checks: { txHash: string; to: string; wei: string }[] = [];
  let finalized = false;
  const t = await pilotHarness({
    async verify(txHash, expected) {
      checks.push({ txHash, ...expected });
      return { block: 53_100_000, finalized };
    },
  });
  try {
    const pilot = await onboard(t.h, t.pilotWallet);
    await syncOnce(t.mirror, t.bridge, t.remote);
    const p = (
      await t.h.call("/api/v1/payments", {
        key: pilot.apiKey,
        body: { amountUsd: "0.01" },
      })
    ).body.payment;
    const zat = p.quote.zecAmountZat;
    const view = async () =>
      (
        await t.h.call(`/api/v1/checkout/${p.id}?token=${p.checkoutToken}`, {
          key: null,
        })
      ).body.checkout;
    assert.equal((await view()).zcashAddress, ADDR);

    // The exact deposit in the next block: detected, then tracked to 20 confirmations.
    t.w.mine(1);
    t.w.update((c) =>
      c.notes.push({
        txid: tx("2"),
        height: 1001,
        zatoshis: zat,
        address: ADDR,
      }),
    );
    const s1 = await syncOnce(t.mirror, t.bridge, t.remote);
    assert.equal(s1.ok, true);
    let cur = await view();
    assert.equal(cur.state, "VERIFYING");
    assert.equal(cur.paymentDetected, true);
    assert.equal(cur.confirmations, 1);
    assert.equal(cur.minimumConfirmations, 20);
    assert.equal(cur.zcashAddress, null);

    t.w.mine(18);
    await syncOnce(t.mirror, t.bridge, t.remote);
    assert.equal((await view()).confirmations, 19);
    assert.equal((await view()).state, "VERIFYING");
    t.w.mine(1);
    await syncOnce(t.mirror, t.bridge, t.remote);
    cur = await view();
    assert.equal(cur.state, "ZEC_CONFIRMED");
    assert.equal(cur.confirmations, 20);
    const merchantView = (
      await t.h.call(`/api/v1/payments/${p.id}`, { key: pilot.apiKey })
    ).body.payment;
    assert.equal(
      merchantView.chainEvidence.paymentDigest,
      t.mirror.getPayment(p.id)!.chainEvidence!.paymentDigest,
    );

    // The existing payout session + `checkout:settlement record` update the mirror.
    t.mirror.transition(p.id, "PAYOUT_PENDING", {});
    t.mirror.setPayout(p.id, BASE_TX, "100000000000000");
    t.mirror.transition(p.id, "PAYOUT_SUBMITTED", {});
    await syncOnce(t.mirror, t.bridge, t.remote);
    cur = await view();
    assert.equal(cur.state, "PAYOUT_SUBMITTED");
    assert.equal(cur.payoutTxHash, BASE_TX);
    assert.deepEqual(checks.at(-1), {
      txHash: BASE_TX,
      to: t.pilotWallet.address,
      wei: "100000000000000",
    });

    // Finalized on Base (after the existing reconcile): the public order completes.
    finalized = true;
    t.mirror.transition(p.id, "PAYOUT_CONFIRMED", {});
    t.mirror.transition(p.id, "COMPLETED", {});
    await syncOnce(t.mirror, t.bridge, t.remote);
    assert.equal((await view()).state, "COMPLETED");
    const receipt = (
      await t.h.call(`/api/v1/payments/${p.id}/receipt`, { key: pilot.apiKey })
    ).body.receipt;
    assert.equal(receipt.simulated, false);
    assert.equal(receipt.zcash.txid, tx("2"));
    assert.equal(receipt.payout.txHash, BASE_TX);
    assert.equal(receipt.payout.wei, "100000000000000");
    // Completed orders drop out of the operator feed; a second checkout can start.
    assert.equal((await t.remote.orders()).length, 0);
    assert.equal(
      (
        await t.h.call("/api/v1/payments", {
          key: pilot.apiKey,
          body: { amountUsd: "0.01" },
        })
      ).status,
      201,
    );
  } finally {
    await t.close();
  }
});

test("public pilot: feed refuses mismatched or over-limit payouts and premature confirmation", async () => {
  const t = await pilotHarness({
    async verify() {
      throw Object.assign(
        new (
          await import("../services/payments/operator-feed.ts")
        ).OperatorFeedError("BASE_PAYOUT_MISMATCH"),
      );
    },
  });
  try {
    const pilot = await onboard(t.h, t.pilotWallet);
    await syncOnce(t.mirror, t.bridge, t.remote);
    const p = (
      await t.h.call("/api/v1/payments", {
        key: pilot.apiKey,
        body: { amountUsd: "0.01" },
      })
    ).body.payment;
    // Payout before confirmation.
    await assert.rejects(
      t.remote.payout(p.id, { txHash: BASE_TX, wei: "1" }),
      /REMOTE_ORDER_NOT_CONFIRMED/,
    );
    // Premature ZEC_CONFIRMED with too few confirmations.
    const evidence = {
      noteKey: `${tx("3")}:3:0`,
      txid: tx("3"),
      pool: 3,
      height: 1001,
      blockHash: "b".repeat(64),
      zatoshis: p.quote.zecAmountZat,
      confirmations: 5,
      minimumConfirmations: 20,
      tip: 1005,
      tipHash: "c".repeat(64),
      ownershipDigest: "e".repeat(64),
      paymentDigest: "d".repeat(64),
      sources: ["a", "b"],
      observedAt: realNow(),
    };
    await assert.rejects(
      t.remote.observe(p.id, {
        state: "ZEC_CONFIRMED",
        txid: tx("3"),
        zat: p.quote.zecAmountZat,
        chainEvidence: evidence,
      }),
      /REMOTE_NOT_CONFIRMED/,
    );
    assert.equal(
      (await t.h.call(`/api/v1/payments/${p.id}`, { key: pilot.apiKey })).body
        .payment.state,
      "AWAITING_PAYMENT",
    );
    // Notes at or before the allocation tip are refused.
    await assert.rejects(
      t.remote.observe(p.id, {
        state: "VERIFYING",
        txid: tx("3"),
        zat: p.quote.zecAmountZat,
        chainEvidence: { ...evidence, height: 1000 },
      }),
      /REMOTE_OBSERVATION_BEFORE_ALLOCATION/,
    );
    // Reach ZEC_CONFIRMED legitimately, then a payout that Base does not confirm is refused.
    await t.remote.observe(p.id, {
      state: "ZEC_CONFIRMED",
      txid: tx("3"),
      zat: p.quote.zecAmountZat,
      chainEvidence: { ...evidence, confirmations: 20, tip: 1020 },
    });
    await assert.rejects(
      t.remote.payout(p.id, { txHash: BASE_TX, wei: "10000000000000000" }),
      /REMOTE_PAYOUT_ABOVE_PILOT_LIMIT/,
    );
    await assert.rejects(
      t.remote.payout(p.id, { txHash: BASE_TX, wei: "100" }),
      /REMOTE_BASE_PAYOUT_MISMATCH/,
    );
    const after = (
      await t.h.call(`/api/v1/payments/${p.id}`, { key: pilot.apiKey })
    ).body.payment;
    assert.equal(after.state, "ZEC_CONFIRMED");
    assert.equal(after.payoutTxHash, null);
  } finally {
    await t.close();
  }
});

test("public pilot: demo orders still complete by replay alongside real orders", async () => {
  const t = await pilotHarness({
    verify: async () => assert.fail("no payout"),
  });
  try {
    const demo = (
      await t.h.call("/api/v1/payments", { body: { amountUsd: "1.00" } })
    ).body.payment;
    // The maintenance tick drives the replay; advance its clock past each step.
    for (
      let i = 1;
      i <= 40 && t.h.app.store.getPayment(demo.id)!.state !== "COMPLETED";
      i++
    )
      t.h.app.observer.tick(realNow() + 5 * i);
    const done = t.h.app.store.getPayment(demo.id)!;
    assert.equal(done.state, "COMPLETED");
    assert.equal(done.evidenceKind, "recorded-mainnet-replay");
    assert.equal((await t.remote.orders()).length, 0);
    assert.equal(
      (await t.h.call("/api/v1/health", { key: null })).body.demoObserver,
      true,
    );
  } finally {
    await t.close();
  }
});
