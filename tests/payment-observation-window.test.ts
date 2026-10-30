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
import {
  assessWalletEvidence,
  readWalletJournalEvidence,
  type EvidenceOrder,
} from "../services/payments/wallet-evidence.ts";
import { checkoutSettlementBinding } from "../services/payments/checkout-settlement.ts";
import { fakeWalletJournal } from "./helpers/fake-wallet-journal.ts";

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
  const journal = fakeWalletJournal(join(dir, "zcash-spend-sessions.sqlite"));
  const sync = () =>
    syncOnce(mirror, bridge, remote, now(), {
      walletEvidence: (txid) => readWalletJournalEvidence(journal.path, txid),
    });
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
  /** The integrated wallet signed and broadcast `txid` for order `p` in time. */
  const walletPaid = (
    p: {
      createdAt: number;
      paymentDeadline: number;
      paymentExpiryHeight: number;
      quote: { zecAmountZat: string };
    },
    txid: string,
    at = p.createdAt + 20,
  ) =>
    journal.add({
      sessionId: txid.slice(0, 32),
      txid,
      destination: ADDR,
      zatoshis: p.quote.zecAmountZat,
      expiryHeight: p.paymentExpiryHeight,
      expires: p.paymentDeadline,
      signApprovedAt: at,
      signedAt: at + 1,
      broadcastApprovedAt: at + 2,
      broadcastAttemptAt: at + 3,
    });
  return {
    h,
    w,
    clock,
    journal,
    walletPaid,
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
      journal.close();
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
    t.walletPaid(p, tx("2")); // integrated wallet signed and broadcast at T0+20 s
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
    const inTime = {
      version: 1,
      sessionId: tx("4").slice(0, 32),
      txid: tx("4"),
      signedDigest: "d".repeat(64),
      destination: ADDR,
      zatoshis: p.quote.zecAmountZat,
      expiryHeight: bound,
      approvalExpires: p.paymentDeadline,
      signApprovedAt: p.createdAt + 20,
      signedAt: p.createdAt + 21,
      broadcastApprovedAt: p.createdAt + 22,
      broadcastAttemptAt: p.createdAt + 23,
    };
    const observe = (height: number) =>
      t.remote.observe(p.id, {
        state: "VERIFYING",
        txid: tx("4"),
        zat: p.quote.zecAmountZat,
        chainEvidence: evidence(height),
        walletEvidence: inTime,
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
        walletEvidence: inTime,
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
    // A later full authenticated scan above the bound proves absence and
    // releases only this observation-incomplete review.
    t.clock.offset = 0;
    mineTo(t.w, p.paymentExpiryHeight);
    await t.sync();
    assert.equal(t.mirror.getPayment(p.id)!.state, "EXPIRED");
    assert.equal(await t.state(p.id), "EXPIRED");
    const events = (
      await t.h.call(`/api/v1/payments/${p.id}/events`, {
        key: t.merchant.apiKey,
      })
    ).body.events;
    assert.equal(
      events.at(-1).data.reason,
      "no_payment_after_delayed_observation",
    );
  } finally {
    await t.close();
  }
});

test("window: a note in the delayed allocation window prevents absence resolution", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    t.clock.offset = 300 + GRACE + 5;
    assert.equal((await t.view(p)).state, "MANUAL_REVIEW");
    t.clock.offset = 0;
    const allocationTip = t.h.app.store.getPayment(p.id)!.allocationTip!;
    t.w.update((c) => {
      c.notes.push({
        txid: tx("f"),
        height: allocationTip + 1,
        zatoshis: p.quote.zecAmountZat,
        address: ADDR,
      });
    });
    mineTo(t.w, p.paymentExpiryHeight);
    await t.sync();
    assert.equal(t.mirror.getPayment(p.id)!.state, "MANUAL_REVIEW");
    assert.equal(await t.state(p.id), "MANUAL_REVIEW");
    assert.ok(
      t.mirror
        .listUnattributed()
        .some((u) => u.txid === tx("f")),
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
    t.walletPaid(p, tx("6"));
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
    t.walletPaid(p, tx("7"));
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

// ---- pre-deadline wallet evidence (the 300 s deadline itself) ----

test("adversarial: signed and broadcast at T0+301 s, mined within the bound, found later — never a payout", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    const T0 = p.createdAt;
    assert.equal(p.paymentDeadline, T0 + 300);
    // Mined at or below the allowed inclusion height: height alone would accept it.
    mineTo(t.w, 1003);
    assert.ok(1003 <= p.paymentExpiryHeight);
    t.w.update((c) =>
      c.notes.push({
        txid: tx("8"),
        height: 1003,
        zatoshis: p.quote.zecAmountZat,
        address: ADDR,
      }),
    );
    // The wallet journal shows SIGN and broadcast only at T0+301 s.
    t.walletPaid(p, tx("8"), T0 + 301);
    t.clock.offset = 400;
    await t.sync();
    const m = t.mirror.getPayment(p.id)!;
    assert.equal(m.state, "MANUAL_REVIEW");
    assert.equal(m.walletEvidence, null);
    const review = t.mirror
      .listEvents(p.id)
      .filter((e) => e.state === "MANUAL_REVIEW")
      .at(-1)!;
    assert.equal(review.data.reason, "no_predeadline_wallet_evidence");
    assert.equal(review.data.detail, "signed_or_broadcast_after_deadline");
    assert.equal(await t.state(p.id), "MANUAL_REVIEW");
    assert.equal(
      (await t.view(p)).reviewReason,
      "no_predeadline_wallet_evidence",
    );
    // Twenty confirmations later it is still not confirmed and cannot be paid out or bound.
    mineTo(t.w, 1003 + 19);
    await t.sync();
    assert.equal(await t.state(p.id), "MANUAL_REVIEW");
    await assert.rejects(
      t.remote.payout(p.id, { txHash: BASE_TX_A, wei: "1" }),
      /ORDER_NOT_CONFIRMED/,
    );
    assert.throws(
      () =>
        checkoutSettlementBinding(t.mirror, p.id, {
          account: "a".repeat(64),
          allowedRecipient: p.request.recipient,
          windowSeconds: 3600,
          now: t.now(),
        }),
      /CHECKOUT_/,
    );
  } finally {
    await t.close();
  }
});

test("adversarial: forged late evidence pushed straight to the public feed is refused", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    const late = {
      version: 1,
      sessionId: tx("9").slice(0, 32),
      txid: tx("9"),
      signedDigest: "d".repeat(64),
      destination: ADDR,
      zatoshis: p.quote.zecAmountZat,
      expiryHeight: p.paymentExpiryHeight,
      approvalExpires: p.paymentDeadline,
      signApprovedAt: p.paymentDeadline + 1,
      signedAt: p.paymentDeadline + 2,
      broadcastApprovedAt: p.paymentDeadline + 3,
      broadcastAttemptAt: p.paymentDeadline + 4,
    };
    const chainEvidence = {
      noteKey: `${tx("9")}:3:0`,
      txid: tx("9"),
      pool: 3,
      height: 1002,
      blockHash: "1".repeat(64),
      zatoshis: p.quote.zecAmountZat,
      confirmations: 1,
      minimumConfirmations: 20,
      tip: 1002,
      tipHash: "2".repeat(64),
      ownershipDigest: "3".repeat(64),
      paymentDigest: null,
      sources: ["https://light.example.org", "https://peer.example.org"],
      observedAt: t.now(),
    };
    const observe = (walletEvidence: unknown) =>
      t.remote.observe(p.id, {
        state: "VERIFYING",
        txid: tx("9"),
        zat: p.quote.zecAmountZat,
        chainEvidence,
        walletEvidence,
      });
    await assert.rejects(
      observe(late),
      /WALLET_EVIDENCE_SIGNED_OR_BROADCAST_AFTER_DEADLINE/,
    );
    await assert.rejects(
      observe(undefined),
      /WALLET_EVIDENCE_NO_WALLET_JOURNAL_EVIDENCE/,
    );
    // Signed in time but the broadcast attempt at exactly the deadline: refused.
    await assert.rejects(
      observe({
        ...late,
        signApprovedAt: p.createdAt + 1,
        signedAt: p.createdAt + 2,
        broadcastApprovedAt: p.createdAt + 3,
        broadcastAttemptAt: p.paymentDeadline,
      }),
      /AFTER_DEADLINE/,
    );
    assert.equal(await t.state(p.id), "AWAITING_PAYMENT");
  } finally {
    await t.close();
  }
});

test("adversarial: a payment from any other wallet (no journal session) is held for manual review", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    mineTo(t.w, 1002);
    t.w.update((c) =>
      c.notes.push({
        txid: tx("a"),
        height: 1002,
        zatoshis: p.quote.zecAmountZat,
        address: ADDR,
      }),
    );
    await t.sync();
    assert.equal(await t.state(p.id), "MANUAL_REVIEW");
    const review = t.mirror
      .listEvents(p.id)
      .filter((e) => e.state === "MANUAL_REVIEW")
      .at(-1)!;
    assert.equal(review.data.detail, "no_wallet_journal_evidence");
  } finally {
    await t.close();
  }
});

test("evidence rule: exact txid, terms, height and strictly-before-deadline timing", () => {
  const order: EvidenceOrder = {
    createdAt: 1000,
    zcashAddress: ADDR,
    quote: { zecAmountZat: "250000" },
    detectedTxid: tx("b"),
    paymentDeadline: 1300,
    paymentExpiryHeight: 2010,
    chainEvidence: { txid: tx("b"), height: 2005 },
  };
  const ok = {
    version: 1 as const,
    sessionId: "c".repeat(32),
    txid: tx("b"),
    signedDigest: "d".repeat(64),
    destination: ADDR,
    zatoshis: "250000",
    expiryHeight: 2010,
    approvalExpires: 1300,
    signApprovedAt: 1010,
    signedAt: 1011,
    broadcastApprovedAt: 1290,
    broadcastAttemptAt: 1299,
  };
  assert.equal(assessWalletEvidence(order, ok), null);
  const cases: [string, Partial<typeof ok> | null, Partial<typeof order>?][] = [
    ["no_wallet_journal_evidence", null],
    ["signed_or_broadcast_after_deadline", { broadcastAttemptAt: 1300 }],
    [
      "signed_or_broadcast_after_deadline",
      { broadcastApprovedAt: 1300, broadcastAttemptAt: 1301 },
    ],
    ["wallet_journal_out_of_order", { signedAt: 1009 }],
    ["wallet_txid_mismatch", { txid: tx("e") }],
    ["wallet_terms_mismatch", { destination: "zs1" + "q".repeat(75) }],
    ["wallet_terms_mismatch", { zatoshis: "250001" }],
    ["wallet_expiry_above_inclusion_height", { expiryHeight: 2011 }],
    ["wallet_session_not_bound_to_deadline", { approvalExpires: 1301 }],
    ["wallet_session_predates_order", { signApprovedAt: 999 }],
    ["wallet_evidence_malformed", { signedDigest: "nothex" }],
    [
      "chain_evidence_mismatch",
      {},
      { chainEvidence: { txid: tx("b"), height: 2011 } },
    ],
    ["order_has_no_payment_window", {}, { paymentDeadline: null }],
  ];
  for (const [reason, change, orderChange] of cases)
    assert.equal(
      assessWalletEvidence(
        { ...order, ...orderChange },
        change === null ? null : { ...ok, ...change },
      ),
      reason,
      reason,
    );
});

test("journal reader: reads the exact v3 schema and only the session that signed this txid", () => {
  const dir = mkdtempSync(join(tmpdir(), "zecone-journal-"));
  const j = fakeWalletJournal(join(dir, "j.sqlite"));
  try {
    j.add({
      sessionId: "f".repeat(32),
      txid: tx("c"),
      destination: ADDR,
      zatoshis: "250000",
      expiryHeight: 2010,
      expires: 1300,
      signApprovedAt: 1010,
      signedAt: 1011,
      broadcastApprovedAt: 1012,
      broadcastAttemptAt: 1013,
    });
    assert.deepEqual(readWalletJournalEvidence(j.path, tx("c")), {
      version: 1,
      sessionId: "f".repeat(32),
      txid: tx("c"),
      signedDigest: "d".repeat(64),
      destination: ADDR,
      zatoshis: "250000",
      expiryHeight: 2010,
      approvalExpires: 1300,
      signApprovedAt: 1010,
      signedAt: 1011,
      broadcastApprovedAt: 1012,
      broadcastAttemptAt: 1013,
    });
    assert.equal(readWalletJournalEvidence(j.path, tx("d")), null);
    assert.equal(readWalletJournalEvidence(j.path, "not-a-txid"), null);
  } finally {
    j.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settlement binding requires the recorded pre-deadline wallet evidence", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    mineTo(t.w, 1002);
    t.w.update((c) =>
      c.notes.push({
        txid: tx("e"),
        height: 1002,
        zatoshis: p.quote.zecAmountZat,
        address: ADDR,
      }),
    );
    t.walletPaid(p, tx("e"));
    mineTo(t.w, 1002 + 19);
    await t.sync();
    assert.equal(t.mirror.getPayment(p.id)!.state, "ZEC_CONFIRMED");
    const bind = () =>
      checkoutSettlementBinding(t.mirror, p.id, {
        account: "a".repeat(64),
        allowedRecipient: p.request.recipient,
        windowSeconds: 3600,
        now: t.now(),
      });
    assert.equal(bind().checkoutPaymentId, p.id);
    // Strip the evidence: binding refuses even though the chain evidence is complete.
    t.mirror.db
      .prepare(`UPDATE payments SET wallet_evidence_json=NULL WHERE id=?`)
      .run(p.id);
    assert.throws(bind, /CHECKOUT_WALLET_EVIDENCE_REQUIRED/);
  } finally {
    await t.close();
  }
});

test("restart: re-running or restarting the sync never duplicates an observation or a settlement", async () => {
  const t = await pilot();
  try {
    const p = (await t.create()).body.payment;
    mineTo(t.w, 1002);
    t.w.update((c) =>
      c.notes.push({
        txid: tx("f"),
        height: 1002,
        zatoshis: p.quote.zecAmountZat,
        address: ADDR,
      }),
    );
    t.walletPaid(p, tx("f"));
    const first = await t.sync();
    assert.deepEqual(first.pushed, [`${p.id}:VERIFYING`]);
    // Same state again, and after an operator restart: nothing is pushed twice.
    assert.deepEqual((await t.sync()).pushed, []);
    t.restartMirror();
    assert.deepEqual((await t.sync()).pushed, []);
    const events = async () =>
      (
        await t.h.call(`/api/v1/payments/${p.id}/events`, {
          key: t.merchant.apiKey,
        })
      ).body.events;
    const detected = (await events()).filter(
      (e: { type: string }) => e.type === "payment.detected",
    ).length;
    assert.equal(detected, 1);
    // Confirm, settle once; a replayed or different payout identity changes nothing.
    mineTo(t.w, 1002 + 19);
    await t.sync();
    assert.equal(await t.state(p.id), "ZEC_CONFIRMED");
    await t.remote.payout(p.id, { txHash: BASE_TX_A, wei: "100000000000000" });
    await t.remote.payout(p.id, { txHash: BASE_TX_A, wei: "100000000000000" });
    await assert.rejects(
      t.remote.payout(p.id, { txHash: BASE_TX_B, wei: "100000000000000" }),
      /PAYOUT_ALREADY_RECORDED/,
    );
    t.restartMirror();
    await t.sync();
    const types = (await events()).map((e: { type: string }) => e.type);
    assert.equal(
      types.filter((x: string) => x === "payment.payout_submitted").length,
      1,
    );
    assert.equal(
      types.filter((x: string) => x === "payment.zec_confirmed").length,
      1,
    );
  } finally {
    await t.close();
  }
});
