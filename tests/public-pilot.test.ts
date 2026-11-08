// Restricted public mainnet pilot: the public API (no viewing key) is fed by the
// operator-side sync, which runs the existing watcher bridge over a local mirror.
// Synthetic chain through the real scanner code; Base verification is injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import {
  DemoQuoteEngine,
  type QuoteEngine,
} from "../services/payments/quote.ts";
import { createHash, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  OperatorPilotQuoteEngine,
  buildCheckoutPilotQuoteStatement,
  signCheckoutPilotQuote,
} from "../services/payments/pilot-quote.ts";
import { httpRemote, syncOnce } from "../scripts/operator-sync.ts";
import { readWalletJournalEvidence } from "../services/payments/wallet-evidence.ts";
import { fakeWalletJournal } from "./helpers/fake-wallet-journal.ts";
import { checkoutOrderId } from "../services/payments/checkout-settlement.ts";

/** Integrated-wallet evidence that `txid` was signed and broadcast in time for `p`. */
const inTime = (
  p: {
    createdAt: number;
    paymentDeadline: number;
    paymentExpiryHeight: number;
    quote: { zecAmountZat: string };
  },
  txid: string,
) => ({
  version: 1 as const,
  sessionId: txid.slice(0, 32),
  txid,
  signedDigest: "d".repeat(64),
  destination: ADDR,
  zatoshis: p.quote.zecAmountZat,
  expiryHeight: p.paymentExpiryHeight,
  approvalExpires: p.paymentDeadline,
  signApprovedAt: p.createdAt + 20,
  signedAt: p.createdAt + 21,
  broadcastApprovedAt: p.createdAt + 22,
  broadcastAttemptAt: p.createdAt + 23,
});

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

const liveQuoteEngine: QuoteEngine = {
  enabled: true,
  quote(input) {
    return {
      ...new DemoQuoteEngine(300).quote(input),
      rateSource: "live-authority" as const,
      authorityDigest: "a".repeat(64),
    };
  },
};

async function pilotHarness(
  check: BasePayoutCheck,
  quoteEngine: QuoteEngine = liveQuoteEngine,
  pilotWallet = newWallet(),
  additionalMerchantOwners: string[] = [],
) {
  const h = await startHarness({
    mode: "monitor",
    now: realNow,
    quoteTtlSeconds: 300,
    monitor: {
      authorized: true,
      source: "operator",
      minimumConfirmations: 20,
      intervalSeconds: 3600,
    },
    pilot: {
      merchantOwner: pilotWallet.address,
      additionalMerchantOwners,
      maxAmountUsd: "1.00",
      maxPayoutWei: 10n ** 15n,
      payout: check,
      quoteEngine,
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
  const journal = fakeWalletJournal(join(dir, "zcash-spend-sessions.sqlite"));
  return {
    h,
    w,
    mirror,
    bridge,
    remote,
    journal,
    dir,
    sync: () =>
      syncOnce(mirror, bridge, remote, realNow(), {
        walletEvidence: (txid) => readWalletJournalEvidence(journal.path, txid),
      }),
    pilotWallet,
    opBase,
    async close() {
      await new Promise<void>((r) => op.close(() => r()));
      mirror.close();
      journal.close();
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
    assert.equal((await t.sync()).ok, true);
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
    assert.equal(real.body.payment.quote.rateSource, "live-authority");
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

test("public beta: an additional allowlisted SIWE owner gets a capped real order", async () => {
  const primary = newWallet();
  const beta = newWallet();
  const t = await pilotHarness(
    { verify: async () => assert.fail("no payout") },
    liveQuoteEngine,
    primary,
    [beta.address],
  );
  try {
    await t.sync();
    const merchant = await onboard(t.h, beta);
    const created = await t.h.call("/api/v1/payments", {
      key: merchant.apiKey,
      body: { amountUsd: "0.01" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.payment.mode, "monitor");
    assert.equal(created.body.payment.settlement, "operator-approved");

    const unapproved = await onboard(t.h);
    const refused = await t.h.call("/api/v1/payments", {
      key: unapproved.apiKey,
      body: { amountUsd: "0.01" },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "real_payments_restricted");
  } finally {
    await t.close();
  }
});

test("public pilot: loopback operator uploads one exact signed live quote", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pilotWallet = newWallet();
  const quoteEngine = new OperatorPilotQuoteEngine({
    authority: "pilot-operator",
    publicKey: publicKey.export({ format: "der", type: "spki" }),
    recipient: pilotWallet.address,
    ttlSeconds: 300,
  });
  const t = await pilotHarness(
    { verify: async () => assert.fail("no payout") },
    quoteEngine,
    pilotWallet,
  );
  try {
    const pilot = await onboard(t.h, t.pilotWallet);
    await t.sync();
    const at = realNow();
    const statement = buildCheckoutPilotQuoteStatement({
      authority: "pilot-operator",
      recipient: t.pilotWallet.address,
      amountUsd: "0.01",
      observations: [
        { provider: "coingecko", ethUsd: "2500", zecUsd: "50", at },
        { provider: "coinpaprika", ethUsd: "2501", zecUsd: "50.1", at },
      ],
      createdAt: at,
      expiresAt: at + 300,
    });
    const envelope = signCheckoutPilotQuote(statement, privateKey);
    await assert.rejects(
      t.remote.quote({
        ...envelope,
        signature: Buffer.alloc(64).toString("base64"),
      }),
      /REMOTE_PILOT_QUOTE_SIGNATURE_INVALID/,
    );
    await t.remote.quote(envelope);
    const created = await t.h.call("/api/v1/payments", {
      key: pilot.apiKey,
      body: { amountUsd: "0.01" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.payment.quote.rateSource, "live-authority");
    assert.equal(created.body.payment.quote.zecAmountZat, "20000");
    const replay = await t.h.call("/api/v1/payments", {
      key: pilot.apiKey,
      body: { amountUsd: "0.01" },
    });
    assert.equal(replay.body.error.code, "live_quote_unavailable");
  } finally {
    await t.close();
  }
});

test("public pilot: watch-only sync consumes immutable wallet evidence uploaded before detection", async () => {
  const t = await pilotHarness({
    verify: async () => assert.fail("no payout"),
  });
  try {
    const pilot = await onboard(t.h, t.pilotWallet);
    await t.sync();
    const p = (
      await t.h.call("/api/v1/payments", {
        key: pilot.apiKey,
        body: { amountUsd: "0.01" },
      })
    ).body.payment;
    const evidence = inTime(p, tx("a"));
    t.w.mine(1);
    t.w.update((chain) =>
      chain.notes.push({
        txid: evidence.txid,
        height: 1001,
        zatoshis: p.quote.zecAmountZat,
        address: ADDR,
      }),
    );
    // Detection can win the race with the Windows evidence upload. The
    // watch-only host waits fail-closed; it neither confirms nor sends the
    // order to review while the authenticated observation window remains open.
    const waiting = await syncOnce(t.mirror, t.bridge, t.remote, realNow(), {
      deferMissingWalletEvidence: true,
    });
    assert.equal(waiting.ok, true);
    assert.equal(t.mirror.getPayment(p.id)!.state, "VERIFYING");
    assert.equal(
      (await t.remote.orders()).find((o) => o.id === p.id)!.state,
      "AWAITING_PAYMENT",
    );

    await assert.rejects(
      t.remote.walletEvidence(p.id, {
        ...evidence,
        signApprovedAt: p.createdAt + 120,
        signedAt: p.createdAt + 121,
        broadcastApprovedAt: p.createdAt + 122,
        broadcastAttemptAt: p.createdAt + 123,
      }),
      /REMOTE_WALLET_EVIDENCE_FROM_FUTURE/,
    );
    await t.remote.walletEvidence(p.id, evidence);
    await t.remote.walletEvidence(p.id, evidence); // exact retry is idempotent
    await assert.rejects(
      t.remote.walletEvidence(p.id, {
        ...evidence,
        signedDigest: "e".repeat(64),
      }),
      /REMOTE_WALLET_EVIDENCE_CHANGED/,
    );
    const uploaded = (await t.remote.orders()).find((o) => o.id === p.id)!;
    assert.deepEqual(uploaded.walletEvidence, evidence);
    const result = await syncOnce(t.mirror, t.bridge, t.remote, realNow(), {
      deferMissingWalletEvidence: true,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(t.mirror.getPayment(p.id)!.walletEvidence, evidence);
    assert.equal(
      (await t.remote.orders()).find((o) => o.id === p.id)!.state,
      "VERIFYING",
    );
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
    await t.sync();
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
    // Sent by the integrated pilot wallet before the payment deadline.
    const ev = inTime(p, tx("2"));
    t.journal.add({ ...ev, expires: ev.approvalExpires });
    const s1 = await t.sync();
    assert.equal(s1.ok, true);
    let cur = await view();
    assert.equal(cur.state, "VERIFYING");
    assert.equal(cur.paymentDetected, true);
    assert.equal(cur.confirmations, 1);
    assert.equal(cur.minimumConfirmations, 20);
    assert.equal(cur.zcashAddress, null);

    t.w.mine(18);
    await t.sync();
    assert.equal((await view()).confirmations, 19);
    assert.equal((await view()).state, "VERIFYING");
    t.w.mine(1);
    await t.sync();
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

    // Operator sync discovers the exact consumed pilot session and read-only
    // submission journal; no manual checkout transition is needed.
    const source = t.mirror.getPayment(p.id)!.chainEvidence!.paymentDigest!,
      terms = {
        version: 1,
        network: "base",
        recipient: t.pilotWallet.address,
        amount: p.quote.ethPayoutWei,
        sourceZatoshis: zat,
        sourcePaymentCommitment: source,
        expires: realNow() + 300,
      },
      submissionJournal = join(t.dir, "submissions.sqlite"),
      pilotJournal = join(t.dir, "pilot-sessions.sqlite"),
      sessionsDirectory = join(t.dir, "sessions"),
      sessionId = "7".repeat(32),
      settlement = { submissionJournal, pilotJournal, sessionsDirectory },
      submissions = new DatabaseSync(submissionJournal),
      pilotSessions = new DatabaseSync(pilotJournal);
    submissions.exec(
      "CREATE TABLE mainnet_submissions(order_id TEXT PRIMARY KEY, network TEXT, source_commitment TEXT, transaction_id TEXT, broadcast_txid TEXT, state TEXT, finalized_ref TEXT, terms_binding TEXT)",
    );
    submissions
      .prepare("INSERT INTO mainnet_submissions VALUES(?,?,?,?,?,?,?,?)")
      .run(
        checkoutOrderId(p.id),
        "base",
        source,
        BASE_TX,
        BASE_TX,
        "broadcast",
        null,
        createHash("sha256").update(JSON.stringify(terms)).digest("hex"),
      );
    pilotSessions.exec(`CREATE TABLE pilot_sessions(id TEXT PRIMARY KEY, source TEXT NOT NULL, state TEXT NOT NULL, transaction_id TEXT);
      CREATE TABLE pilot_consumed_sources(source TEXT PRIMARY KEY, session_id TEXT NOT NULL);`);
    pilotSessions
      .prepare("INSERT INTO pilot_sessions VALUES(?,?,?,?)")
      .run(sessionId, source, "BROADCAST", BASE_TX);
    pilotSessions
      .prepare("INSERT INTO pilot_consumed_sources VALUES(?,?)")
      .run(source, sessionId);
    mkdirSync(join(sessionsDirectory, sessionId), { recursive: true });
    writeFileSync(
      join(sessionsDirectory, sessionId, "plan.json"),
      JSON.stringify({ terms }),
    );
    await syncOnce(t.mirror, t.bridge, t.remote, realNow(), {
      walletEvidence: (txid) => readWalletJournalEvidence(t.journal.path, txid),
      settlement,
    });
    cur = await view();
    assert.equal(cur.state, "PAYOUT_SUBMITTED");
    assert.equal(cur.payoutTxHash, BASE_TX);
    assert.deepEqual(checks.at(-1), {
      txHash: BASE_TX,
      to: t.pilotWallet.address,
      wei: p.quote.ethPayoutWei,
    });

    // Finalized on Base (after the existing reconcile): the public order completes.
    finalized = true;
    submissions
      .prepare(
        "UPDATE mainnet_submissions SET state=?,finalized_ref=? WHERE order_id=?",
      )
      .run("finalized", "53100000", checkoutOrderId(p.id));
    submissions.close();
    pilotSessions.close();
    await syncOnce(t.mirror, t.bridge, t.remote, realNow(), {
      walletEvidence: (txid) => readWalletJournalEvidence(t.journal.path, txid),
      settlement,
    });
    assert.equal((await view()).state, "COMPLETED");
    const receipt = (
      await t.h.call(`/api/v1/payments/${p.id}/receipt`, { key: pilot.apiKey })
    ).body.receipt;
    assert.equal(receipt.simulated, false);
    assert.equal(receipt.zcash.txid, tx("2"));
    assert.equal(receipt.payout.txHash, BASE_TX);
    assert.equal(receipt.payout.wei, p.quote.ethPayoutWei);
    // Completed orders drop out of the operator feed; a second checkout can start
    // once the chain passes the first order's inclusion height.
    assert.equal((await t.remote.orders()).length, 0);
    t.w.mine(Math.max(0, p.paymentExpiryHeight - t.w.chain.tip + 1));
    await syncOnce(t.mirror, t.bridge, t.remote, realNow(), {
      walletEvidence: (txid) => readWalletJournalEvidence(t.journal.path, txid),
      settlement,
    });
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
    await t.sync();
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
        walletEvidence: inTime(p, tx("3")),
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
        walletEvidence: inTime(p, tx("3")),
        chainEvidence: { ...evidence, height: 1000 },
      }),
      /REMOTE_OBSERVATION_BEFORE_ALLOCATION/,
    );
    await assert.rejects(
      t.remote.observe(p.id, {
        state: "VERIFYING",
        txid: tx("3"),
        zat: p.quote.zecAmountZat,
        walletEvidence: inTime(p, tx("3")),
        chainEvidence: {
          ...evidence,
          height: 1001,
          sources: ["provider-a", " Provider-A "],
        },
      }),
      /REMOTE_OBSERVATION_SOURCES_NOT_INDEPENDENT/,
    );
    // Reach ZEC_CONFIRMED legitimately, then a payout that Base does not confirm is refused.
    await t.remote.observe(p.id, {
      state: "ZEC_CONFIRMED",
      txid: tx("3"),
      zat: p.quote.zecAmountZat,
      chainEvidence: { ...evidence, confirmations: 20, tip: 1020 },
      walletEvidence: inTime(p, tx("3")),
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
