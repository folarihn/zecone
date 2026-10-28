// Public checkout presentation: source-level regression tests.
// Runs under `node --import tsx --test tests/ui/checkout-modes.node.ts` (the
// `.node.ts` name keeps Playwright from collecting it). Synthetic only: the
// pilot contract test drives the real payment API, operator feed and watcher
// bridge in-process over a fake chain; no keys, no network, no funds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchCheckout,
  fetchWatcherHealth,
  parseZip321,
  presentCheckout,
  validateCheckoutView,
  zecToZat,
  type CheckoutView,
} from "../../sdk/src/checkout.ts";
import { ZecOneError } from "../../sdk/src/types.ts";
import {
  OPERATOR_TOKEN,
  newWallet,
  onboard,
  startHarness,
} from "../helpers/payments-harness.ts";
import { fakeWatcher, type FakeChain } from "../helpers/fake-watcher.ts";
import { DEFAULT_CHECKOUT_ADDRESS } from "../../services/payments/api.ts";
import { PaymentStore } from "../../services/payments/store.ts";
import { PaymentWatchBridge } from "../../services/payments/watch-bridge.ts";
import type { BasePayoutCheck } from "../../services/payments/operator-feed.ts";
import { DemoQuoteEngine, type QuoteEngine } from "../../services/payments/quote.ts";
import { httpRemote, syncOnce } from "../../scripts/operator-sync.ts";

const ADDR = DEFAULT_CHECKOUT_ADDRESS;
const NOW = 1_800_000_000;
const ID = "pay_" + "a".repeat(26);
const BASE_TX = "0x" + "c".repeat(64);
const URI = `zcash:${ADDR}?amount=0.02&label=ZecOne%20Checkout`;

const verifiedPilotQuoteEngine: QuoteEngine = {
  enabled: true,
  quote(input) {
    return {
      ...new DemoQuoteEngine(300).quote(input),
      rateSource: "live-authority" as const,
      authorityDigest: "a".repeat(64),
    };
  },
};

/** A real-mode (pilot) checkout view awaiting payment; override per case. */
function view(
  over: Partial<CheckoutView> & { reviewReason?: string | null } = {},
): CheckoutView {
  return {
    id: ID,
    object: "checkout",
    state: "AWAITING_PAYMENT",
    mode: "monitor",
    simulated: false,
    confirmations: null,
    minimumConfirmations: 20,
    settlement: "operator-approved",
    merchant: { name: "Pilot Merchant" },
    description: null,
    amountUsd: "1.00",
    payoutChain: "base",
    recipient: "0x4b5750d7675f14eB844B74477015302Bf31AE2dB",
    quote: {
      zecAmount: "0.02",
      zecAmountZat: "2000000",
      ethPayout: "0.0004",
      rateSource: "live-authority",
      expiresAt: NOW + 300,
    },
    zcashAddress: ADDR,
    paymentUri: URI,
    paymentDetected: false,
    evidenceKind: null,
    payoutTxHash: null,
    payoutExplorerUrl: null,
    expiresAt: NOW + 300,
    createdAt: NOW - 10,
    updatedAt: NOW - 10,
    serverTime: NOW,
    ...over,
  };
}
const demo = (over: Partial<CheckoutView> = {}) =>
  view({
    mode: "demo",
    simulated: true,
    settlement: "disabled",
    zcashAddress: null,
    paymentUri: null,
    minimumConfirmations: null,
    ...over,
  });
const ctx = { now: NOW, expectedId: ID };

test("demo checkout never exposes an address, QR or payable URI", () => {
  for (const state of [
    "AWAITING_PAYMENT",
    "PAYMENT_DETECTED",
    "VERIFYING",
    "ZEC_CONFIRMED",
    "PAYOUT_SUBMITTED",
  ] as const) {
    const p = presentCheckout(demo({ state }), ctx);
    assert.equal(p.mode, "simulated");
    assert.equal(p.modeLabel, "SIMULATED DEMO");
    assert.match(p.modeDetail, /No funds move/);
    assert.equal(p.payment, null);
    assert.equal(p.receipt, null);
    assert.equal(p.status, "SIMULATED");
  }
  // A demo view that carries an address is distrusted outright, never rendered.
  for (const bad of [
    demo({ zcashAddress: ADDR }),
    demo({ paymentUri: URI }),
    view({ simulated: true }),
  ]) {
    const p = presentCheckout(bad, ctx);
    assert.equal(p.status, "UNVERIFIED");
    assert.equal(p.payment, null);
  }
  // Simulated completion is a labelled replay, never "COMPLETED".
  const done = presentCheckout(
    demo({
      state: "COMPLETED",
      payoutTxHash: BASE_TX,
      payoutExplorerUrl: `https://basescan.org/tx/${BASE_TX}`,
    }),
    ctx,
  );
  assert.equal(done.status, "SIMULATED_COMPLETE");
  assert.equal(done.phase, "completed");
  assert.match(done.statusDetail, /No funds moved/);
  assert.equal(done.receipt?.recorded, true);
});

test("mainnet observation shows the exact ZIP-321 request", () => {
  const p = presentCheckout(view(), ctx);
  assert.equal(p.mode, "mainnet");
  assert.equal(p.modeLabel, "MAINNET PAYMENT");
  assert.equal(p.status, "OBSERVING");
  assert.match(p.statusDetail, /authenticated watcher evidence/);
  assert.deepEqual(p.payment, {
    address: ADDR,
    zecAmount: "0.02",
    zecAmountZat: "2000000",
    uri: URI,
    expiresAt: NOW + 300,
    secondsLeft: 300,
  });
  assert.deepEqual(parseZip321(URI), { address: ADDR, amount: "0.02" });
  assert.equal(zecToZat("0.02"), "2000000");
  assert.equal(zecToZat("1.00000001"), "100000001");
});

test("an inconsistent payment request is refused (fail closed)", () => {
  const cases: [string, Partial<CheckoutView>][] = [
    [
      "amount differs from URI",
      { paymentUri: `zcash:${ADDR}?amount=0.2&label=x` },
    ],
    ["address differs from URI", { zcashAddress: "zs1" + "q".repeat(75) }],
    [
      "multi-payment URI",
      { paymentUri: `${URI}&address.1=${ADDR}&amount.1=1` },
    ],
    ["memo parameter", { paymentUri: `${URI}&memo=AAAA` }],
    ["duplicate amount", { paymentUri: `${URI}&amount=0.02` }],
    [
      "transparent address",
      {
        zcashAddress: "t1" + "a".repeat(33),
        paymentUri: `zcash:t1${"a".repeat(33)}?amount=0.02`,
      },
    ],
    ["missing URI", { paymentUri: null }],
    ["missing address", { zcashAddress: null }],
  ];
  for (const [name, over] of cases) {
    const p = presentCheckout(view(over), ctx);
    assert.equal(p.status, "UNVERIFIED", name);
    assert.equal(p.payment, null, name);
  }
  const zat = presentCheckout(
    view({ quote: { ...view().quote!, zecAmountZat: "2000001" } }),
    ctx,
  );
  assert.deepEqual(
    [zat.status, zat.mode, zat.payment],
    ["UNVERIFIED", "unknown", null],
  );
  // A view for another payment id, or garbage, is never shown.
  assert.equal(
    presentCheckout(view({ id: "pay_" + "b".repeat(26) }), ctx).status,
    "UNVERIFIED",
  );
  for (const junk of [null, "x", 1, [], { object: "checkout" }])
    assert.equal(presentCheckout(junk, ctx).status, "UNVERIFIED");
  assert.deepEqual(validateCheckoutView(view(), ID), []);
});

test("confirmation progress is current / required and never overstated", () => {
  const p = presentCheckout(
    view({
      state: "VERIFYING",
      zcashAddress: null,
      paymentUri: null,
      paymentDetected: true,
      confirmations: 7,
    }),
    ctx,
  );
  assert.equal(p.status, "CONFIRMING");
  assert.equal(p.statusLabel, "CONFIRMING");
  assert.deepEqual(p.confirmations, { current: 7, required: 20 });
  assert.equal(p.payment, null);
  const capped = presentCheckout(
    view({
      state: "VERIFYING",
      zcashAddress: null,
      paymentUri: null,
      confirmations: 45,
    }),
    ctx,
  );
  assert.deepEqual(capped.confirmations, { current: 20, required: 20 });
  const detected = presentCheckout(
    view({
      state: "PAYMENT_DETECTED",
      zcashAddress: null,
      paymentUri: null,
      minimumConfirmations: null,
    }),
    ctx,
  );
  assert.equal(detected.status, "OBSERVING");
  assert.equal(detected.confirmations, null);
});

test("quote expiry hides the payment request", () => {
  assert.equal(
    presentCheckout(view(), { ...ctx, now: NOW + 299 }).payment?.secondsLeft,
    1,
  );
  for (const now of [NOW + 300, NOW + 301]) {
    const p = presentCheckout(view(), { ...ctx, now });
    assert.equal(p.status, "EXPIRED");
    assert.equal(p.statusLabel, "EXPIRED");
    assert.equal(p.payment, null);
    assert.match(p.statusDetail, /Do not send ZEC/);
  }
  // The earlier of the order and quote expiry wins.
  assert.equal(
    presentCheckout(view({ quote: { ...view().quote!, expiresAt: NOW + 5 } }), {
      ...ctx,
      now: NOW + 5,
    }).status,
    "EXPIRED",
  );
  // No expiry at all: refuse to show a payable request.
  assert.equal(
    presentCheckout(view({ expiresAt: null, quote: null }), ctx).status,
    "UNVERIFIED",
  );
  const expired = presentCheckout(
    view({ state: "EXPIRED", zcashAddress: null, paymentUri: null }),
    ctx,
  );
  assert.deepEqual(
    [expired.status, expired.phase, expired.payment],
    ["EXPIRED", "expired", null],
  );
});

test("provider disagreement, paused watcher and stale views fail closed", () => {
  const paused = presentCheckout(view(), { ...ctx, watcher: { ready: false } });
  assert.equal(paused.status, "WATCHER_PAUSED");
  assert.equal(paused.payment, null);
  assert.match(paused.statusDetail, /Do not send ZEC/);
  const pausedConfirming = presentCheckout(
    view({
      state: "VERIFYING",
      zcashAddress: null,
      paymentUri: null,
      confirmations: 3,
    }),
    {
      ...ctx,
      watcher: { ready: false },
    },
  );
  assert.equal(pausedConfirming.status, "WATCHER_PAUSED");
  const disagreement = presentCheckout(
    view({
      state: "MANUAL_REVIEW",
      reviewReason: "mainnet_provider_disagreement",
    }),
    ctx,
  );
  assert.equal(disagreement.status, "PROVIDER_DISAGREEMENT");
  assert.equal(disagreement.statusLabel, "PROVIDER DISAGREEMENT");
  assert.equal(disagreement.payment, null);
  const stale = presentCheckout(view(), { ...ctx, stale: true });
  assert.equal(stale.payment, null);
  assert.ok(stale.issues.includes("stale_view"));
  // Unknown health (unreachable) does not invent a status.
  assert.ok(presentCheckout(view(), { ...ctx, watcher: null }).payment);
  assert.ok(
    presentCheckout(view(), { ...ctx, watcher: { ready: true } }).payment,
  );
});

test("reorganization and manual review never offer a payout", () => {
  const reorg = presentCheckout(
    view({
      state: "MANUAL_REVIEW",
      reviewReason: "chain_reorganization",
      zcashAddress: null,
      paymentUri: null,
    }),
    ctx,
  );
  assert.deepEqual(
    [reorg.status, reorg.statusLabel, reorg.phase],
    ["REORG", "REORG", "review"],
  );
  assert.match(reorg.statusDetail, /no automatic payout/);
  for (const reason of [
    undefined,
    null,
    "owned_note_requirements_not_met",
    "operator_review",
    "<script>",
  ]) {
    const p = presentCheckout(
      view({ state: "MANUAL_REVIEW", reviewReason: reason }),
      ctx,
    );
    assert.equal(p.status, "MANUAL_REVIEW");
    assert.equal(p.statusLabel, "MANUAL REVIEW");
    assert.match(p.statusDetail, /No automatic payout/);
    assert.equal(p.payment, null);
    assert.equal(p.receipt, null);
  }
  const failed = presentCheckout(
    view({ state: "FAILED", zcashAddress: null, paymentUri: null }),
    ctx,
  );
  assert.deepEqual(
    [failed.status, failed.phase, failed.receipt],
    ["FAILED", "failed", null],
  );
});

test("payout pending is distinct from completed; completed needs a finalized Base receipt", () => {
  const real = {
    zcashAddress: null,
    paymentUri: null,
    confirmations: 20,
    paymentDetected: true,
  } as const;
  for (const state of [
    "ZEC_CONFIRMED",
    "PAYOUT_PENDING",
    "PAYOUT_SUBMITTED",
    "PAYOUT_CONFIRMED",
  ] as const) {
    const p = presentCheckout(
      view({
        ...real,
        state,
        payoutTxHash: state === "ZEC_CONFIRMED" ? null : BASE_TX,
      }),
      ctx,
    );
    assert.equal(p.status, "PAYOUT_PENDING", state);
    assert.equal(p.statusLabel, "PAYOUT PENDING");
    assert.equal(p.receipt, null, `${state}: no receipt before completion`);
    assert.notEqual(p.phase, "completed");
  }
  // Monitor-only checkout (settlement disabled) stops at ZEC confirmed, no payout promised.
  const monitor = presentCheckout(
    view({ ...real, state: "ZEC_CONFIRMED", settlement: "disabled" }),
    ctx,
  );
  assert.equal(monitor.status, "ZEC_CONFIRMED");
  assert.match(monitor.statusDetail, /Automatic payout is disabled/);

  const completed = presentCheckout(
    view({
      ...real,
      state: "COMPLETED",
      payoutTxHash: BASE_TX,
      payoutExplorerUrl: `https://basescan.org/tx/${BASE_TX}`,
    }),
    ctx,
  );
  assert.deepEqual(
    [completed.status, completed.phase],
    ["COMPLETED", "completed"],
  );
  assert.deepEqual(completed.receipt, {
    txHash: BASE_TX,
    explorerUrl: `https://basescan.org/tx/${BASE_TX}`,
    recorded: false,
  });
  // COMPLETED without a (consistent) receipt is not shown as paid.
  for (const over of [
    { payoutTxHash: null, payoutExplorerUrl: null },
    { payoutTxHash: BASE_TX, payoutExplorerUrl: null },
    {
      payoutTxHash: BASE_TX,
      payoutExplorerUrl: `https://evil.example/tx/${BASE_TX}`,
    },
    {
      payoutTxHash: BASE_TX,
      payoutExplorerUrl: "https://basescan.org/tx/0x" + "d".repeat(64),
    },
  ]) {
    const p = presentCheckout(
      view({ ...real, state: "COMPLETED", ...over }),
      ctx,
    );
    assert.equal(p.status, "PAYOUT_PENDING");
    assert.equal(p.receipt, null);
    assert.ok(p.issues.includes("completed_without_finalized_receipt"));
  }
  assert.equal(
    presentCheckout(
      view({ ...real, state: "COMPLETED", payoutTxHash: "0xnothex" }),
      ctx,
    ).status,
    "UNVERIFIED",
  );
});

test("wrong or missing checkout token is refused by the API", async () => {
  const h = await startHarness();
  try {
    const p = (
      await h.call("/api/v1/payments", {
        key: h.app.demoApiKey!,
        body: { amountUsd: "1.00" },
      })
    ).body.payment;
    assert.ok(p?.id, "demo payment created");
    const ok = await fetchCheckout(h.base, p.id, p.checkoutToken);
    assert.equal(
      presentCheckout(ok, { now: ok.serverTime, expectedId: p.id }).status,
      "SIMULATED",
    );
    for (const token of ["f".repeat(40), "", p.checkoutToken.slice(0, 39)])
      await assert.rejects(
        fetchCheckout(h.base, p.id, token),
        (e: ZecOneError) => e.status === 404 && e.code === "not_found",
      );
    const missing = await fetch(`${h.base}/api/v1/checkout/${p.id}`);
    assert.equal(missing.status, 404);
    // A token for one payment does not open another.
    const p2 = (
      await h.call("/api/v1/payments", {
        key: h.app.demoApiKey!,
        body: { amountUsd: "2.00" },
      })
    ).body.payment;
    await assert.rejects(
      fetchCheckout(h.base, p2.id, p.checkoutToken),
      (e: ZecOneError) => e.status === 404,
    );
    // Public health: demo mode has no watcher, so health is "unknown", not "ready".
    assert.equal(await fetchWatcherHealth(h.base), null);
  } finally {
    await h.close();
  }
});

// ---- contract: real pilot backend views → customer-facing statuses ----

const realNow = () => Math.floor(Date.now() / 1000);
const genesis = (): FakeChain => ({
  tip: 1000,
  hashes: { 1000: "0".repeat(60) + "1000" },
  notes: [],
  defaultAddress: ADDR,
});

test("contract: pilot lifecycle from the real payment API renders the right labels", async () => {
  let finalized = false;
  const check: BasePayoutCheck = {
    verify: async () => ({ block: 53_100_000, finalized }),
  };
  const pilotWallet = newWallet();
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
      maxAmountUsd: "1.00",
      maxPayoutWei: 10n ** 15n,
      payout: check,
      quoteEngine: verifiedPilotQuoteEngine,
    },
    operatorListenerOnly: true,
  });
  const op: Server = createServer(
    (req, res) => void h.app.handleOperator(req, res),
  );
  await new Promise<void>((r) => op.listen(0, "127.0.0.1", () => r()));
  const dir = mkdtempSync(join(tmpdir(), "zecone-ux-mirror-"));
  const mirror = new PaymentStore(join(dir, "mirror.sqlite"));
  try {
    const w = fakeWatcher(genesis());
    const bridge = new PaymentWatchBridge(mirror, w.scanner, {
      receivingAddress: ADDR,
      minimumConfirmations: 20,
      now: realNow,
    });
    const remote = httpRemote(
      `http://127.0.0.1:${(op.address() as AddressInfo).port}/`,
      OPERATOR_TOKEN,
    );
    const pilot = await onboard(h, pilotWallet);
    await syncOnce(mirror, bridge, remote);
    assert.deepEqual(await fetchWatcherHealth(h.base), { ready: true });
    const p = (
      await h.call("/api/v1/payments", {
        key: pilot.apiKey,
        body: { amountUsd: "0.01" },
      })
    ).body.payment;
    const present = async () => {
      const v = await fetchCheckout(h.base, p.id, p.checkoutToken);
      return presentCheckout(v, {
        now: v.serverTime,
        expectedId: p.id,
        watcher: await fetchWatcherHealth(h.base),
      });
    };

    let s = await present();
    assert.deepEqual(
      [s.mode, s.modeLabel, s.status],
      ["mainnet", "MAINNET PAYMENT", "OBSERVING"],
    );
    assert.ok(
      s.payment,
      `payment request shown (issues: ${s.issues.join(",")})`,
    );
    assert.equal(s.payment.address, ADDR);
    assert.equal(s.payment.zecAmountZat, p.quote.zecAmountZat);
    assert.equal(parseZip321(s.payment.uri)?.amount, p.quote.zecAmount);

    w.mine(1);
    w.update((c) =>
      c.notes.push({
        txid: "2".repeat(64),
        height: 1001,
        zatoshis: p.quote.zecAmountZat,
        address: ADDR,
      }),
    );
    await syncOnce(mirror, bridge, remote);
    s = await present();
    assert.deepEqual(
      [s.status, s.confirmations, s.payment],
      ["CONFIRMING", { current: 1, required: 20 }, null],
    );

    w.mine(19);
    await syncOnce(mirror, bridge, remote);
    s = await present();
    assert.deepEqual(
      [s.status, s.confirmations],
      ["PAYOUT_PENDING", { current: 20, required: 20 }],
    );

    mirror.transition(p.id, "PAYOUT_PENDING", {});
    mirror.setPayout(p.id, BASE_TX, "100000000000000");
    mirror.transition(p.id, "PAYOUT_SUBMITTED", {});
    await syncOnce(mirror, bridge, remote);
    s = await present();
    assert.deepEqual(
      [s.status, s.receipt],
      ["PAYOUT_PENDING", null],
      "submitted but not final",
    );

    finalized = true;
    mirror.transition(p.id, "PAYOUT_CONFIRMED", {});
    mirror.transition(p.id, "COMPLETED", {});
    await syncOnce(mirror, bridge, remote);
    s = await present();
    assert.equal(s.status, "COMPLETED");
    assert.equal(s.receipt?.txHash, BASE_TX);
    assert.equal(s.receipt?.recorded, false);
  } finally {
    await new Promise<void>((r) => op.close(() => r()));
    mirror.close();
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  }
});

// ---- security invariants over the browser-facing sources and bundles ----

const ROOT = join(import.meta.dirname, "..", "..");
const BROWSER_SOURCES = [
  "sdk/src/checkout.ts",
  "sdk/src/react.tsx",
  "app/components/checkout-panel.tsx",
  "app/pay/[id]/page.tsx",
  "app/embed/[id]/page.tsx",
  "app/embed/[id]/embed-client.tsx",
];

test("browser checkout sources cannot sign, broadcast, mark paid or read secrets", () => {
  for (const f of BROWSER_SOURCES) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.doesNotMatch(
      src,
      /from\s+["'][^"']*services\//,
      `${f}: imports a backend service`,
    );
    assert.doesNotMatch(
      src,
      /zecone-server|process\.env/,
      `${f}: reads server configuration`,
    );
    assert.doesNotMatch(
      src,
      /privateKeyToAccount|signTransaction|sendTransaction|sendRawTransaction|eth_send|mnemonic|seed phrase|spendingKey|passphrase/i,
      f,
    );
    assert.doesNotMatch(
      src,
      /Authorization|Bearer|apiKey|zk_[0-9a-f]/,
      `${f}: handles merchant credentials`,
    );
    assert.doesNotMatch(
      src,
      /method:\s*["'](POST|PUT|PATCH|DELETE)/,
      `${f}: issues a mutating request`,
    );
    assert.doesNotMatch(
      src,
      />\s*(Mark (as )?paid|Complete payment|Simulate success|Confirm payment)\s*</i,
      `${f}: completion control`,
    );
    assert.doesNotMatch(
      src,
      /localhost:\d|127\.0\.0\.1/,
      `${f}: talks to a loopback wallet`,
    );
  }
});

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

test("built browser bundles carry no merchant key or secret material", (t) => {
  const staticDir = join(ROOT, ".next", "static");
  if (!existsSync(staticDir))
    return t.skip("no production build; run npm run build:web first");
  const sentinels = [
    "ZECONE_API_KEY",
    "ZECONE_DEMO_SECRET",
    "ZECONE_WEBHOOK_SECRET",
    "ZECONE_OPERATOR_TOKEN",
  ]
    .map((k) => process.env[k])
    .filter((v): v is string => !!v && v.length >= 8);
  const forbidden = [
    /zk_[0-9a-f]{24}_[A-Za-z0-9_-]{8,}/, // merchant API key
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /secret-extended-key-(main|test)1[0-9a-z]{40,}/, // Zcash spending key
    /xprv[1-9A-HJ-NP-Za-km-z]{100,}/,
  ];
  let scanned = 0;
  for (const f of files(staticDir)) {
    if (!/\.(js|css|html|json|txt)$/.test(f)) continue;
    const text = readFileSync(f, "utf8");
    scanned++;
    for (const re of forbidden)
      assert.doesNotMatch(text, re, `${f} matches ${re}`);
    for (const s of sentinels)
      assert.ok(!text.includes(s), `${f} contains a server secret value`);
  }
  assert.ok(scanned > 0, "scanned the client bundle");
});
