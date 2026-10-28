// Hosted and embedded checkout in a real browser, every checkout mode and
// fail-closed state. Presentation-only: the public /zecone API is intercepted
// with fixtures, so no payment API, wallet, chain or funds are involved.
import { test, expect, type Page } from "@playwright/test";

const ID = "pay_" + "a".repeat(26);
const TOKEN = "b".repeat(40);
const ADDR =
  "u1qqq8z5wnpx5yft50ahvm2cq3rzumnszs2r53ccruhnk4xrv3su4wtgxwvwz5chqfv8l2v7atn83kdjcfmp9lpaf7clwu32yufqhf4eah6r0k5dvxq85nc8ky2keej6cz9wlr8aflajelgsy4s8nj8j3s388t4l9zejcfe5dcevdmnyr2";
const URI = `zcash:${ADDR}?amount=0.02&label=ZecOne%20Checkout`;
const BASE_TX = "0x" + "c".repeat(64);
const nowS = () => Math.floor(Date.now() / 1000);

function view(over: Record<string, unknown> = {}) {
  const t = nowS();
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
      expiresAt: t + 300,
    },
    zcashAddress: ADDR,
    paymentUri: URI,
    paymentDetected: false,
    evidenceKind: null,
    payoutTxHash: null,
    payoutExplorerUrl: null,
    expiresAt: t + 300,
    createdAt: t - 5,
    updatedAt: t - 5,
    serverTime: t,
    ...over,
  };
}
const demo = (over: Record<string, unknown> = {}) =>
  view({
    mode: "demo",
    simulated: true,
    settlement: "disabled",
    zcashAddress: null,
    paymentUri: null,
    minimumConfirmations: null,
    ...over,
  });
const after = { zcashAddress: null, paymentUri: null, paymentDetected: true };

type Fixture = {
  checkout: (() => unknown) | null;
  status?: number;
  watcherReady?: boolean | null;
};

/** Serve /zecone/api/v1/* from a mutable fixture. The SSE stream is refused so the SDK polls. */
async function serve(page: Page, fx: Fixture) {
  await page.route("**/zecone/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events"))
      return route.fulfill({ status: 503, body: "" });
    if (path.endsWith("/health"))
      return route.fulfill({
        json: {
          status: "ok",
          watcher:
            fx.watcherReady === null || fx.watcherReady === undefined
              ? null
              : { ready: fx.watcherReady },
        },
      });
    if (fx.status && fx.status !== 200)
      return route.fulfill({
        status: fx.status,
        json: { error: { code: "not_found", message: "checkout not found" } },
      });
    return route.fulfill({ json: { checkout: fx.checkout?.() } });
  });
}

const status = (page: Page) => page.getByTestId("zecone-status");
const panel = (page: Page) => page.locator("[data-zecone-checkout]");

async function expectNoPaymentRequest(page: Page) {
  await expect(page.getByTestId("zecone-address")).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
  await expect(page.locator("a[href^='zcash:']")).toHaveCount(0);
  expect(await page.content()).not.toContain(ADDR);
}

async function expectNoCompletionControls(page: Page) {
  const names = await page
    .locator("[data-zecone-checkout] button")
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute("aria-label") ?? e.textContent),
    );
  for (const n of names) expect(n).toMatch(/^Copy (amount|address)$/);
  await expect(
    page.getByRole("button", {
      name: /mark|paid|complete|simulate|confirm|replay|sign|send|broadcast/i,
    }),
  ).toHaveCount(0);
}

for (const vp of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 375, height: 812 },
]) {
  test.describe(`${vp.name} ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("demo checkout: SIMULATED DEMO, never an address or QR", async ({
      page,
    }) => {
      await serve(page, { checkout: () => demo() });
      await page.goto(`/pay/${ID}?t=${TOKEN}`);
      await expect(panel(page)).toHaveAttribute(
        "data-zecone-checkout",
        "awaiting",
      );
      await expect(page.getByTestId("zecone-mode")).toContainText(
        "SIMULATED DEMO",
      );
      await expect(page.getByTestId("zecone-mode")).toContainText(
        "No funds move",
      );
      await expect(page.getByTestId("zecone-example")).toContainText(
        "Example payment interface, simulated",
      );
      await expectNoPaymentRequest(page);
      await expectNoCompletionControls(page);
    });

    test("mainnet observation: exact ZIP-321 request, QR and expiry", async ({
      page,
    }) => {
      await serve(page, { checkout: () => view(), watcherReady: true });
      await page.goto(`/pay/${ID}?t=${TOKEN}`);
      await expect(page.getByTestId("zecone-mode")).toContainText(
        "MAINNET PAYMENT",
      );
      await expect(page.getByTestId("zecone-mode")).toContainText(
        "Real ZEC address and amount",
      );
      await expect(status(page)).toContainText("OBSERVING");
      await expect(page.getByTestId("zecone-address")).toHaveText(ADDR);
      await expect(page.getByTestId("zecone-amount")).toHaveText("0.02 ZEC");
      await expect(page.getByTestId("zecone-uri")).toHaveAttribute("href", URI);
      const qr = page.getByRole("img", { name: "Zcash payment QR code" });
      await expect(qr).toBeVisible();
      await expect(page.getByTestId("zecone-expiry")).toContainText(
        /Quote expires in (?:5:00|4:\d\d)/,
      );
      await expect(page.getByText(/not a wallet/)).toBeVisible();
      await expectNoCompletionControls(page);
      // Layout: the address wraps, nothing overflows horizontally, QR fits the viewport.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const box = (await qr.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
      await page.screenshot({
        path: test.info().outputPath(`mainnet-${vp.name}.png`),
        fullPage: true,
      });
    });
  });
}

test("quote expiry hides the request in the browser without a backend change", async ({
  page,
}) => {
  const t = nowS();
  const fixed = view({
    expiresAt: t + 3,
    quote: { ...view().quote, expiresAt: t + 3 },
    serverTime: t,
  });
  await serve(page, {
    checkout: () => ({ ...fixed, serverTime: nowS() }),
    watcherReady: true,
  });
  await page.goto(`/pay/${ID}?t=${TOKEN}`);
  await expect(page.getByTestId("zecone-address")).toHaveText(ADDR);
  await expect(status(page)).toContainText("EXPIRED", { timeout: 8000 });
  await expect(status(page)).toContainText("Do not send ZEC");
  await expectNoPaymentRequest(page);
});

test("confirmation progress → payout pending → completed with a finalized Base receipt", async ({
  page,
}) => {
  let current = view({ ...after, state: "VERIFYING", confirmations: 7 });
  await serve(page, { checkout: () => current, watcherReady: true });
  await page.goto(`/pay/${ID}?t=${TOKEN}`);
  await expect(status(page)).toContainText("CONFIRMING");
  await expect(page.getByTestId("zecone-confirmations")).toContainText(
    "Confirmations: 7 / 20",
  );
  await expect(
    page.getByRole("progressbar", { name: "Zcash confirmations" }),
  ).toHaveAttribute("aria-valuenow", "7");
  await expectNoPaymentRequest(page);

  current = view({
    ...after,
    state: "PAYOUT_SUBMITTED",
    confirmations: 20,
    payoutTxHash: BASE_TX,
    updatedAt: nowS(),
  });
  await expect(status(page)).toContainText("PAYOUT PENDING");
  await expect(status(page)).toContainText("not finalized");
  await expect(page.getByTestId("zecone-receipt")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Base payout/ })).toHaveCount(0);
  await expect(panel(page)).not.toHaveAttribute(
    "data-zecone-checkout",
    "completed",
  );

  // Backend says COMPLETED but omits the receipt: still not shown as paid.
  current = view({
    ...after,
    state: "COMPLETED",
    confirmations: 20,
    updatedAt: nowS() + 1,
  });
  await expect(status(page)).toContainText("not shown as paid");
  await expect(status(page)).toContainText("PAYOUT PENDING");
  await expect(panel(page)).not.toHaveAttribute(
    "data-zecone-checkout",
    "completed",
  );

  current = view({
    ...after,
    state: "COMPLETED",
    confirmations: 20,
    payoutTxHash: BASE_TX,
    payoutExplorerUrl: `https://basescan.org/tx/${BASE_TX}`,
    updatedAt: nowS() + 2,
  });
  // The terminal state stops polling, so reload to pick up the final view.
  await page.reload();
  await expect(panel(page)).toHaveAttribute(
    "data-zecone-checkout",
    "completed",
  );
  await expect(status(page)).toContainText("COMPLETED");
  await expect(page.getByTestId("zecone-receipt")).toContainText(BASE_TX);
  await expect(
    page.getByRole("link", { name: "View Base payout ↗" }),
  ).toHaveAttribute("href", `https://basescan.org/tx/${BASE_TX}`);
  await expectNoCompletionControls(page);
});

test("provider disagreement and a paused watcher fail closed", async ({
  page,
}) => {
  const fx: Fixture = { checkout: () => view(), watcherReady: false };
  await serve(page, fx);
  await page.goto(`/pay/${ID}?t=${TOKEN}`);
  await expect(status(page)).toContainText("WATCHER PAUSED");
  await expectNoPaymentRequest(page);

  fx.checkout = () =>
    view({
      ...after,
      state: "MANUAL_REVIEW",
      reviewReason: "mainnet_provider_disagreement",
    });
  await page.reload();
  await expect(status(page)).toContainText("PROVIDER DISAGREEMENT");
  await expect(status(page)).toContainText("no automatic payout");
  await expect(panel(page)).toHaveAttribute("data-zecone-checkout", "review");
});

test("reorganization and manual review", async ({ page }) => {
  const fx: Fixture = {
    checkout: () =>
      view({
        ...after,
        state: "MANUAL_REVIEW",
        reviewReason: "chain_reorganization",
        confirmations: 4,
      }),
  };
  await serve(page, fx);
  await page.goto(`/pay/${ID}?t=${TOKEN}`);
  await expect(status(page)).toContainText("REORG");
  await expect(status(page)).toContainText("Do not pay again");
  fx.checkout = () => view({ ...after, state: "MANUAL_REVIEW" });
  await page.reload();
  await expect(status(page)).toContainText("MANUAL REVIEW");
  await expect(status(page)).toContainText("No automatic payout");
  await expectNoPaymentRequest(page);
  await expectNoCompletionControls(page);
});

test("wrong, missing or malformed checkout token", async ({ page }) => {
  // Wrong token: the API refuses it; nothing from any earlier view is shown.
  await serve(page, { checkout: () => view(), status: 404 });
  await page.goto(`/pay/${ID}?t=${"f".repeat(40)}`);
  await expect(status(page)).toContainText("INVALID LINK");
  await expect(panel(page)).toHaveAttribute("data-zecone-checkout", "error");
  await expectNoPaymentRequest(page);
  // Missing or malformed token: refused before any request is made.
  for (const url of [
    `/pay/${ID}`,
    `/pay/${ID}?t=xyz`,
    `/pay/pay_bad?t=${TOKEN}`,
  ]) {
    await page.goto(url);
    await expect(
      page.getByText("This checkout link is incomplete"),
    ).toBeVisible();
    await expectNoPaymentRequest(page);
  }
  await page.goto(`/embed/${ID}`);
  await expect(page.getByText("Invalid checkout link.")).toBeVisible();
});

test("a view for a different payment is never rendered", async ({ page }) => {
  await serve(page, { checkout: () => view({ id: "pay_" + "e".repeat(26) }) });
  await page.goto(`/pay/${ID}?t=${TOKEN}`);
  await expect(status(page)).toContainText("CANNOT VERIFY");
  await expect(page.getByText("Pilot Merchant")).toHaveCount(0);
  await expectNoPaymentRequest(page);
});

test("embedded checkout: same states, posts only verified completion", async ({
  page,
}) => {
  let current = view({ ...after, state: "COMPLETED", confirmations: 20 });
  await serve(page, { checkout: () => current, watcherReady: true });
  await page.addInitScript(() => {
    // Pretend to be framed so the embed posts to "parent" (ourselves).
    Object.defineProperty(window, "parent", {
      value: {
        postMessage: (m: unknown) => ((window as any).__posted ??= []).push(m),
      },
    });
  });
  await page.goto(`/embed/${ID}?t=${TOKEN}`);
  await expect(status(page)).toContainText("PAYOUT PENDING");
  const posted = () =>
    page.evaluate(() =>
      ((window as any).__posted ?? []).map((m: any) => m.type),
    );
  expect(await posted()).not.toContain("completed");

  current = view({
    ...after,
    state: "COMPLETED",
    confirmations: 20,
    payoutTxHash: BASE_TX,
    payoutExplorerUrl: `https://basescan.org/tx/${BASE_TX}`,
  });
  await page.reload();
  await expect(status(page)).toContainText("COMPLETED");
  await expect.poll(posted).toContain("completed");

  current = demo();
  await page.reload();
  await expect(page.getByTestId("zecone-mode")).toContainText("SIMULATED DEMO");
  await expectNoPaymentRequest(page);
});

test("rendered HTML and loaded scripts carry no merchant key or server secret", async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on("response", async (r) => {
    if (r.request().resourceType() === "script")
      scripts.push(await r.text().catch(() => ""));
  });
  await serve(page, { checkout: () => view(), watcherReady: true });
  for (const url of [
    `/pay/${ID}?t=${TOKEN}`,
    `/embed/${ID}?t=${TOKEN}`,
    "/checkout",
  ]) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const html = await page.content();
    expect(html).not.toMatch(/zk_[0-9a-f]{24}_[A-Za-z0-9_-]{8,}/);
    expect(html).not.toMatch(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|secret-extended-key-main1/,
    );
  }
  expect(scripts.length).toBeGreaterThan(0);
  const sentinels = [
    "ZECONE_API_KEY",
    "ZECONE_DEMO_SECRET",
    "ZECONE_WEBHOOK_SECRET",
  ]
    .map((k) => process.env[k])
    .filter((v): v is string => !!v && v.length >= 8);
  for (const js of scripts) {
    expect(js).not.toMatch(/zk_[0-9a-f]{24}_[A-Za-z0-9_-]{8,}/);
    for (const s of sentinels) expect(js.includes(s)).toBe(false);
  }
});

test("a lost connection hides payment details until an unchanged view is re-verified", async ({
  page,
}) => {
  const fixed = view();
  const fx: Fixture = {
    checkout: () => ({ ...fixed, serverTime: nowS() }),
    watcherReady: true,
  };
  await serve(page, fx);
  await page.goto(`/pay/${ID}?t=${TOKEN}`);
  await expect(page.getByTestId("zecone-address")).toHaveText(ADDR);
  fx.status = 502;
  await expect(page.getByText(/Connection lost/)).toBeVisible();
  await expectNoPaymentRequest(page);
  // The backend view is identical after reconnecting; details must come back.
  fx.status = undefined;
  await expect(page.getByTestId("zecone-address")).toHaveText(ADDR);
  await expect(page.getByText(/Connection lost/)).toHaveCount(0);
});
