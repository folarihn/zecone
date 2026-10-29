// Payment deadline vs authenticated observation (restricted mainnet pilot).
//
// The address is payable for at most 300 s, but the authenticated watcher runs
// behind the chain tip, so a deposit mined in time can be detected later. A
// deposit qualifies only if its authenticated inclusion height is within the
// order's persisted bound. Real public API + operator feed + operator mirror +
// watch bridge over a fake chain; synthetic only, no keys, chain or funds.
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
import {
  DemoQuoteEngine,
  type QuoteEngine,
} from "../services/payments/quote.ts";
import type { BasePayoutCheck } from "../services/payments/operator-feed.ts";
import {
  INCLUSION_MARGIN_BLOCKS,
  MAX_INCLUSION_BLOCKS,
  PaymentWindowError,
  paymentWindow,
} from "../services/payments/payment-window.ts";
import { httpRemote, syncOnce } from "../scripts/operator-sync.ts";
import { presentCheckout } from "../sdk/src/checkout.ts";

const ADDR = DEFAULT_CHECKOUT_ADDRESS;
const GRACE = 900;
const tx = (c: string) => c.repeat(64);
const BASE_TX_A = "0x" + "a".repeat(64);
const BASE_TX_B = "0x" + "b".repeat(64);

const pilotQuotes: QuoteEngine = {
  enabled: true,
  quote(input) {
    return {
      ...new DemoQuoteEngine(300).quote(input),
      rateSource: "live-authority" as const,
      authorityDigest: "a".repeat(64),
    };
  },
};

async function pilot(opts: { finalized?: boolean } = {}) {
  const clock = { offset: 0 };
  const now = () => Math.floor(Date.now() / 1000) + clock.offset;
  const check: BasePayoutCheck = {
    verify: async () => ({
      block: 53_100_000,
      finalized: opts.finalized ?? false,
    }),
  };
  const owner = newWallet();
  const h = await startHarness({
    mode: "monitor",
    now,
    quoteTtlSeconds: 300,
    observationGraceSeconds: GRACE,
    monitor: {
      authorized: true,
      source: "operator",
      minimumConfirmations: 20,
      intervalSeconds: 3600,
    },
    pilot: {
      merchantOwner: owner.address,
      maxAmountUsd: "1.00",
      maxPayoutWei: 10n ** 15n,
      payout: check,
      quoteEngine: pilotQuotes,
    },
    operatorListenerOnly: true,
  });
  const op: Server = createServer(
    (req, res) => void h.app.handleOperator(req, res),
  );
  await new Promise<void>((r) => op.listen(0, "127.0.0.1", () => r()));
  const dir = mkdtempSync(join(tmpdir(), "zecone-window-"));
  const mirrorPath = join(dir, "mirror.sqlite");
  let mirror = new PaymentStore(mirrorPath);
  const chain: FakeChain = {
    tip: 1000,
    hashes: { 1000: "0".repeat(60) + "1000" },
    notes: [],
    defaultAddress: ADDR,
  };
  const w = fakeWatcher(chain);
  const bridgeFor = (m: PaymentStore) =>
    new PaymentWatchBridge(m, w.scanner, {
      receivingAddress: ADDR,
      minimumConfirmations: 20,
      now,
    });
  let bridge = bridgeFor(mirror);
  const remote = httpRemote(
    `http://127.0.0.1:${(op.address() as AddressInfo).port}/`,
    OPERATOR_TOKEN,
  );
  const merchant = await onboard(h, owner);
  const sync = () => syncOnce(mirror, bridge, remote, now());
  await sync();
  const create = () =>
    h.call("/api/v1/payments", {
      key: merchant.apiKey,
      body: { amountUsd: "0.01" },
    });
  const view = async (p: { id: string; checkoutToken: string }) =>
    (
      await h.call(`/api/v1/checkout/${p.id}?token=${p.checkoutToken}`, {
        key: null,
      })
    ).body.checkout;
  const state = async (id: string) =>
    (await h.call(`/api/v1/payments/${id}`, { key: merchant.apiKey })).body
      .payment.state as string;
  return {
    h,
    w,
    clock,
    now,
    remote,
    merchant,
    sync,
    create,
    view,
    state,
    get mirror() {
      return mirror;
    },
    /** Simulate an operator restart: reopen the mirror database from disk. */
    restartMirror() {
      mirror.close();
      mirror = new PaymentStore(mirrorPath);
      bridge = bridgeFor(mirror);
    },
    async close() {
      await new Promise<void>((r) => op.close(() => r()));
      mirror.close();
      rmSync(dir, { recursive: true, force: true });
      await h.close();
    },
  };
}

/** Mine until the chain tip equals `height`. */
const mineTo = (w: ReturnType<typeof fakeWatcher>, height: number) =>
  w.mine(Math.max(0, height - w.chain.tip));

test("window: bound derivation is persisted, bounded and refuses stale tips", () => {
  const now = 1_800_000_000;
  const w = paymentWindow({
    now,
    paymentDeadline: now + 300,
    tip: 1000,
    tipObservedAt: now - 60,
    observationGraceSeconds: 2700,
  });
  // ceil((60 + 300) / 75) = 5 blocks expected, plus the ZIP-203 margin.
  assert.deepEqual(w, {
    paymentDeadline: now + 300,
    observationDeadline: now + 3000,
    paymentExpiryHeight: 1000 + 5 + INCLUSION_MARGIN_BLOCKS,
  });
  assert.throws(
    () =>
      paymentWindow({
        now,
        paymentDeadline: now + 300,
        tip: 1000,
        tipObservedAt: now - 75 * MAX_INCLUSION_BLOCKS,
        observationGraceSeconds: 2700,
      }),
    (e: Error) =>
      e instanceof PaymentWindowError &&
      e.message === "WATCHER_TIP_TOO_OLD_FOR_INCLUSION_BOUND",
  );
  for (const bad of [
    { paymentDeadline: now, observationGraceSeconds: 2700 },
    { paymentDeadline: now + 901, observationGraceSeconds: 2700 },
    { paymentDeadline: now + 300, observationGraceSeconds: 899 },
    { paymentDeadline: now + 300, observationGraceSeconds: 7201 },
  ])
    assert.throws(
      () => paymentWindow({ now, tip: 1000, tipObservedAt: now, ...bad }),
      PaymentWindowError,
    );
});

test("window: deposit mined before the deadline but detected later is accepted; 20 confirmations stay mandatory", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    assert.equal(p.paymentDeadline, p.expiresAt);
    assert.equal(p.paymentDeadline - p.createdAt, 300);
    assert.equal(p.observationDeadline, p.paymentDeadline + GRACE);
    const bound: number = p.paymentExpiryHeight;
    assert.ok(bound > 1000 && bound <= 1000 + MAX_INCLUSION_BLOCKS);
    assert.equal((await t.view(p)).zcashAddress, ADDR);

    // Mined in time (well below the bound) but not yet seen by the watcher.
    mineTo(t.w, 1003);
    t.w.update((c) =>
      c.notes.push({
        txid: tx("2"),
        height: 1003,
        zatoshis: p.quote.zecAmountZat,
        address: ADDR,
      }),
    );
    t.clock.offset = 400; // past the 300 s payment deadline

    // Address and QR are gone at the deadline; the order is still observing.
    let v = await t.view(p);
    assert.equal(v.state, "AWAITING_PAYMENT");
    assert.equal(v.zcashAddress, null);
    assert.equal(v.paymentUri, null);
    assert.equal(v.observationDeadline, p.observationDeadline);
    const shown = presentCheckout(v, { now: t.now(), expectedId: p.id });
    assert.equal(shown.status, "WINDOW_CLOSED");
    assert.equal(
      shown.statusDetail,
      "Payment window closed — checking for a payment mined before the deadline.",
    );
    assert.equal(shown.payment, null);
    // The allocation stays reserved: no new order can take the address.
    assert.equal((await t.create()).body.error.code, "checkout_busy");

    // Delayed authenticated detection still attributes it.
    await t.sync();
    assert.equal(await t.state(p.id), "VERIFYING");
    v = await t.view(p);
    assert.equal(v.zcashAddress, null);

    // Twenty confirmations remain mandatory.
    mineTo(t.w, 1003 + 18);
    await t.sync();
    assert.equal(await t.state(p.id), "VERIFYING");
    mineTo(t.w, 1003 + 19);
    await t.sync();
    assert.equal(await t.state(p.id), "ZEC_CONFIRMED");

    // Duplicate settlement / replay: one payout identity per order.
    await t.remote.payout(p.id, { txHash: BASE_TX_A, wei: "100000000000000" });
    assert.equal(await t.state(p.id), "PAYOUT_SUBMITTED");
    await assert.rejects(
      t.remote.payout(p.id, { txHash: BASE_TX_B, wei: "100000000000000" }),
      /PAYOUT_ALREADY_RECORDED/,
    );
  } finally {
    await t.close();
  }
});

test("window: deposit mined after the inclusion height never qualifies and goes to manual review", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    const bound: number = p.paymentExpiryHeight;
    mineTo(t.w, bound + 1);
    t.w.update((c) =>
      c.notes.push({
        txid: tx("3"),
        height: bound + 1,
        zatoshis: p.quote.zecAmountZat,
        address: ADDR,
      }),
    );
    t.clock.offset = 400;
    await t.sync();
    // Operator mirror: recovery record plus manual review, never an attribution.
    assert.equal(t.mirror.getPayment(p.id)!.state, "MANUAL_REVIEW");
    assert.equal(t.mirror.getPayment(p.id)!.detectedTxid, null);
    assert.deepEqual(
      t.mirror.listUnattributed().map((u) => [u.txid, u.reason]),
      [[tx("3"), "mined_after_inclusion_height"]],
    );
    // Public order follows; the late payment is explained and cannot be paid out.
    assert.equal(await t.state(p.id), "MANUAL_REVIEW");
    const v = await t.view(p);
    assert.equal(v.reviewReason, "late_deposit");
    assert.equal(v.zcashAddress, null);
    assert.match(
      presentCheckout(v, { now: t.now(), expectedId: p.id }).statusDetail,
      /mined after the payment deadline/,
    );
    await assert.rejects(
      t.remote.payout(p.id, { txHash: BASE_TX_A, wei: "1" }),
      /ORDER_NOT_CONFIRMED/,
    );
  } finally {
    await t.close();
  }
});

test("window: the public feed independently refuses observations outside (allocation tip, inclusion height]", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    const bound: number = p.paymentExpiryHeight;
    const evidence = (height: number) => ({
      noteKey: `${tx("4")}:3:0`,
      txid: tx("4"),
      pool: 3,
      height,
      blockHash: "1".repeat(64),
      zatoshis: p.quote.zecAmountZat,
      confirmations: 1,
      minimumConfirmations: 20,
      tip: height,
      tipHash: "2".repeat(64),
      ownershipDigest: "3".repeat(64),
      paymentDigest: null,
      sources: ["https://light.example.org", "https://peer.example.org"],
      observedAt: t.now(),
    });
    const observe = (height: number) =>
      t.remote.observe(p.id, {
        state: "VERIFYING",
        txid: tx("4"),
        zat: p.quote.zecAmountZat,
        chainEvidence: evidence(height),
      });
    await assert.rejects(
      observe(bound + 1),
      /OBSERVATION_AFTER_INCLUSION_HEIGHT/,
    );
    await assert.rejects(observe(1000), /OBSERVATION_BEFORE_ALLOCATION/);
    assert.equal(await t.state(p.id), "AWAITING_PAYMENT");
    await observe(bound); // the bound itself qualifies
    assert.equal(await t.state(p.id), "VERIFYING");
    // Premature confirmation is still refused.
    await assert.rejects(
      t.remote.observe(p.id, {
        state: "ZEC_CONFIRMED",
        txid: tx("4"),
        zat: p.quote.zecAmountZat,
        chainEvidence: evidence(bound),
      }),
      /NOT_CONFIRMED/,
    );
  } finally {
    await t.close();
  }
});

test("window: no payment expires only when the verified tip proves absence, then a new order cannot claim the old window", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    const bound: number = p.paymentExpiryHeight;
    t.clock.offset = 400;
    mineTo(t.w, bound - 1);
    await t.sync();
    assert.equal(
      await t.state(p.id),
      "AWAITING_PAYMENT",
      "tip below the bound proves nothing yet",
    );
    mineTo(t.w, bound);
    await t.sync();
    assert.equal(await t.state(p.id), "EXPIRED");
    const events = (
      await t.h.call(`/api/v1/payments/${p.id}/events`, {
        key: t.merchant.apiKey,
      })
    ).body.events;
    assert.equal(events.at(-1).data.reason, "no_payment_by_inclusion_height");

    // The next order may allocate only above the previous inclusion height.
    assert.equal((await t.create()).body.error.code, "checkout_busy");
    mineTo(t.w, bound + 1);
    await t.sync();
    const p2 = (await t.create()).body.payment;
    assert.equal(p2.state, "AWAITING_PAYMENT");
    assert.ok(t.h.app.store.getPayment(p2.id)!.allocationTip! > bound);
    // A deposit from the old window surfacing now is never p2's payment.
    t.w.update((c) =>
      c.notes.push({
        txid: tx("5"),
        height: bound,
        zatoshis: p2.quote.zecAmountZat,
        address: ADDR,
      }),
    );
    await t.sync();
    assert.equal(await t.state(p2.id), "AWAITING_PAYMENT");
    assert.ok(
      t.mirror
        .listUnattributed()
        .some(
          (u) => u.txid === tx("5") && u.reason === "note_predates_checkout",
        ),
    );
  } finally {
    await t.close();
  }
});

test("window: absence not proven by the observation deadline goes to manual review, never expiry or payout", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    // The watcher never reports a tip at or above the bound (e.g. stalled).
    t.clock.offset = 300 + GRACE + 5;
    const v = await t.view(p);
    assert.equal(v.state, "MANUAL_REVIEW");
    assert.equal(v.reviewReason, "observation_incomplete");
    assert.equal(v.zcashAddress, null);
    await assert.rejects(
      t.remote.payout(p.id, { txHash: BASE_TX_A, wei: "1" }),
      /ORDER_NOT_CONFIRMED/,
    );
  } finally {
    await t.close();
  }
});

test("window: restart during observation preserves both deadlines and the bound", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    t.clock.offset = 400;
    await t.sync();
    const before = t.mirror.getPayment(p.id)!;
    assert.equal(before.state, "AWAITING_PAYMENT");
    t.restartMirror();
    const after = t.mirror.getPayment(p.id)!;
    assert.deepEqual(
      [
        after.paymentDeadline,
        after.observationDeadline,
        after.paymentExpiryHeight,
        after.allocationTip,
      ],
      [
        p.paymentDeadline,
        p.observationDeadline,
        p.paymentExpiryHeight,
        before.allocationTip,
      ],
    );
    // After restart the order still observes; a deposit mined in time still qualifies.
    mineTo(t.w, 1002);
    t.w.update((c) =>
      c.notes.push({
        txid: tx("6"),
        height: 1002,
        zatoshis: p.quote.zecAmountZat,
        address: ADDR,
      }),
    );
    await t.sync();
    assert.equal(await t.state(p.id), "VERIFYING");
  } finally {
    await t.close();
  }
});

test("window: reorganization invalidates a provisional delayed attribution", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    mineTo(t.w, 1002);
    t.w.update((c) =>
      c.notes.push({
        txid: tx("7"),
        height: 1002,
        zatoshis: p.quote.zecAmountZat,
        address: ADDR,
      }),
    );
    t.clock.offset = 400;
    await t.sync();
    assert.equal(await t.state(p.id), "VERIFYING");
    t.w.update((c) => {
      c.notes = c.notes.filter((n) => n.txid !== tx("7"));
      c.hashes[1001] = "c".repeat(64);
      c.hashes[1002] = "d".repeat(64);
      c.tip = 1003;
      c.hashes[1003] = "e".repeat(64);
    });
    await t.sync();
    assert.equal(t.mirror.getPayment(p.id)!.state, "MANUAL_REVIEW");
    assert.equal(await t.state(p.id), "MANUAL_REVIEW");
    assert.equal((await t.view(p)).reviewReason, "chain_reorganization");
  } finally {
    await t.close();
  }
});

test("window: demo checkouts are unchanged (no observation window, plain expiry, never an address)", async () => {
  const t = await pilot();
  try {
    const d = (
      await t.h.call("/api/v1/payments", {
        key: t.h.app.demoApiKey!,
        body: { amountUsd: "1.00" },
      })
    ).body.payment;
    assert.equal(d.mode, "demo");
    assert.deepEqual(
      [d.paymentDeadline, d.observationDeadline, d.paymentExpiryHeight],
      [null, null, null],
    );
    assert.equal((await t.view(d)).zcashAddress, null);
    t.clock.offset = d.expiresAt - d.createdAt + 1;
    const v = await t.view(d);
    assert.equal(v.state, "EXPIRED");
    assert.equal(v.observationDeadline, null);
    assert.equal(
      presentCheckout(v, { now: t.now(), expectedId: d.id }).status,
      "EXPIRED",
    );
  } finally {
    await t.close();
  }
});
