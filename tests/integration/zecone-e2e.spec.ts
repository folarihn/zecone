// Browser end-to-end tests across the three local processes. Demo mode only:
// payments complete via the payment API's server-side observer replaying recorded
// mainnet evidence. No transaction is signed or broadcast.
import { test, expect, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { installTestWallet } from "./wallet-fixture.ts";

// Isolated instances started by playwright.integration.config.ts.
const WEB = process.env.ZECONE_IT_WEB!;
const DAPP = process.env.ZECONE_IT_DAPP!;
const API = process.env.ZECONE_IT_API!;
const WEB_HOST = new URL(WEB).host;

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

test.describe.configure({ mode: "serial" });

test("public site: every route renders and every internal link resolves", async ({ page, request }) => {
  const errors = trackErrors(page);
  const seen = new Set<string>();
  for (const route of ["/", "/checkout", "/dashboard", "/docs", "/explorer", "/security", "/wallet"]) {
    const res = await page.goto(WEB + route);
    expect(res?.status(), route).toBe(200);
    await expect(page.locator("main")).toBeVisible();
    for (const href of await page.locator("a[href^='/']").evaluateAll((as) => as.map((a) => a.getAttribute("href")!))) {
      seen.add(href.split("#")[0]);
    }
  }
  for (const href of seen) {
    const r = await request.get(WEB + href);
    expect(r.status(), `link ${href}`).toBeLessThan(400);
  }
  expect(errors).toEqual([]);
});

test("homepage widget: live quote preview, then a hosted demo checkout that completes server-side", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(WEB + "/");
  await expect(page.getByTestId("service-status")).toContainText("Demo mode");
  // Default $5 (regression: larger demo amounts must not hit the relayer liquidity guard).
  await expect(page.getByTestId("quote-zec")).toHaveText("0.1 ZEC");
  await page.getByRole("button", { name: "$1", exact: true }).click();
  await expect(page.getByTestId("quote-zec")).toHaveText("0.02 ZEC");
  await page.getByRole("button", { name: "$20", exact: true }).click();
  await expect(page.getByTestId("quote-zec")).toHaveText("0.4 ZEC");
  await expect(page.getByTestId("quote-eth")).toContainText("ETH");
  await page.getByRole("button", { name: "Continue to demo checkout" }).click();
  await page.waitForURL(/\/pay\/pay_[0-9a-f]{26}\?t=[0-9a-f]{40}$/);
  const checkout = page.locator("[data-zecone-checkout]");
  await expect(checkout).toHaveAttribute("data-zecone-checkout", "awaiting");
  // Simulated checkout: a labelled example, never a payable address, QR or zcash: URI.
  await expect(page.getByTestId("zecone-example")).toContainText("Example payment interface — simulated");
  await expect(page.getByTestId("zecone-address")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Zcash payment QR code" })).toHaveCount(0);
  await expect(page.locator("a[href^='zcash:']")).toHaveCount(0);
  expect(await page.content()).not.toContain("u1qqq8z5wnpx5yft50");
  // There is no way to complete a payment from the page.
  await expect(page.getByRole("button", { name: /complete|replay|mark paid/i })).toHaveCount(0);
  await expect(checkout).toHaveAttribute("data-zecone-checkout", "completed", { timeout: 30_000 });
  await expect(checkout).toContainText("Simulated payment complete");
  await expect(page.getByRole("link", { name: /View the recorded Base payout/ })).toHaveAttribute("href", /basescan\.org\/tx\/0xc677e9fa/);
  expect(errors).toEqual([]);
});

test("demo store: embedded checkout progresses through each step", async ({ page }) => {
  await page.goto(WEB + "/checkout");
  await page.getByRole("radio", { name: /Tip the builder/ }).click();
  await page.getByRole("button", { name: "Pay $2.50 with ZEC" }).click();
  const checkout = page.locator("[data-zecone-checkout]");
  await expect(checkout).toHaveAttribute("data-zecone-checkout", "awaiting", { timeout: 15_000 });
  await expect(checkout).toContainText("0.05");
  await expect(checkout).toHaveAttribute("data-zecone-checkout", "processing", { timeout: 20_000 });
  await expect(checkout).toHaveAttribute("data-zecone-checkout", "completed", { timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Access Pass example DApp" })).toBeVisible();
});

test("merchant dashboard: wallet onboarding with chain switch, API key once, payment link", async ({ page }) => {
  const wallet = await installTestWallet(page, { chainId: 1 }); // starts on Ethereum mainnet
  await page.goto(WEB + "/dashboard");
  await page.getByLabel(/Business name/).fill("Pixel Pass");
  await page.getByRole("button", { name: "Connect wallet and sign in" }).click();
  await expect(page.getByTestId("api-key")).toHaveText(/^zk_[0-9a-f]{24}_sk_[0-9a-f]{48}$/, { timeout: 15_000 });
  expect(wallet.signed).toHaveLength(1);
  expect(wallet.signed[0]).toContain("Chain ID: 8453"); // switched to Base before signing
  expect(wallet.signed[0]).toContain(`${WEB_HOST} wants you to sign in`);
  await expect(page.getByRole("heading", { name: "Pixel Pass" })).toBeVisible();
  // The session is an httpOnly cookie: not readable by page scripts.
  expect(await page.evaluate(() => document.cookie)).not.toContain("zecone_session");
  await page.getByRole("button", { name: "I've stored it" }).click();
  await expect(page.getByTestId("api-key")).toHaveCount(0);
  // Payment link.
  await page.getByLabel("Amount (USD)").fill("3.00");
  await page.getByLabel("What it's for").fill("Invoice 7");
  await page.getByRole("button", { name: "Create link" }).click();
  const link = await page.getByTestId("payment-link").textContent();
  expect(link).toMatch(/\/pay\/pay_[0-9a-f]{26}\?t=[0-9a-f]{40}$/);
  await expect(page.getByTestId("payments")).toContainText("Invoice 7");
  // Webhook test without an endpoint is disabled; key rotation works.
  await page.getByRole("button", { name: "Rotate key and revoke old ones" }).click();
  await expect(page.getByTestId("api-key")).toBeVisible();
  // Reload: still signed in via the cookie session.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pixel Pass" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Connect wallet and sign in" })).toBeVisible();
});

test("Access Pass DApp: onboard, buy, embedded checkout, verified webhook, server-side unlock", async ({ page, request }) => {
  const errors = trackErrors(page);
  await installTestWallet(page, { chainId: 8453 });
  await page.goto(DAPP + "/");
  await expect(page.locator("#setup-status")).toHaveText("Not connected to ZecOne yet.");
  // Buying is impossible before merchant setup.
  await expect(page.locator("#buy")).toBeDisabled();
  await page.locator("#connect").click();
  await expect(page.locator("#network")).toHaveText("Base");
  await page.locator("#sign").click();
  await expect(page.locator("#setup-status")).toHaveText("Connected to ZecOne.", { timeout: 15_000 });
  await expect(page.locator("#m-payout")).toHaveText(/^0x[0-9a-fA-F]{40}$/);
  // Secrets never reach the browser.
  const cfg = await (await page.request.get(DAPP + "/api/config")).json();
  expect(JSON.stringify(cfg)).not.toMatch(/zk_|whsec_|sk_/);

  // Single active checkout: if another demo checkout is still settling, the
  // merchant gets checkout_busy and retries.
  for (let i = 0; i < 20; i++) {
    await page.locator("#buy").click();
    await page.locator("#checkout:visible, #buy-error:not(:empty)").first().waitFor();
    if (await page.locator("#checkout").isVisible()) break;
    await expect(page.locator("#buy-error")).toContainText("one active checkout");
    await page.waitForTimeout(1500);
  }
  await expect(page.locator("#checkout")).toBeVisible();
  const frame = page.frameLocator("#embed");
  await expect(frame.locator("[data-zecone-checkout]")).toHaveAttribute("data-zecone-checkout", "awaiting", { timeout: 20_000 });
  await expect(frame.getByTestId("zecone-example")).toBeVisible();
  await expect(frame.getByTestId("zecone-address")).toHaveCount(0);

  // Content is locked server-side for anyone without this browser's order cookie.
  const anon = await request.get(DAPP + "/api/content?order=00000000-0000-0000-0000-000000000000");
  expect(anon.status()).toBe(404);

  await expect(page.locator("#unlocked")).toBeVisible({ timeout: 40_000 });
  await expect(page.locator("#c-title")).toHaveText("Welcome to the members' room");
  await expect(page.locator("#c-evidence")).toContainText("replay of recorded mainnet transactions");
  await expect(page.locator("#steps li.done")).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("Access Pass rejects forged webhooks and the API exposes no public completion route", async ({ request }) => {
  const body = JSON.stringify({ id: "evt_forged", type: "payment.completed", payment: { id: "pay_" + "0".repeat(26) } });
  const forged = await request.post(DAPP + "/webhooks/zecone", {
    data: body,
    headers: { "Content-Type": "application/json", "X-ZecOne-Signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
  });
  expect(forged.status()).toBe(401);
  const demo = await request.post(API + "/api/v1/demo/pay_" + "0".repeat(26));
  expect(demo.status()).toBe(404);
  const op = await request.post(API + "/api/v1/operator/demo-replay/pay_" + "0".repeat(26));
  expect(op.status()).toBe(404);
  const health = await (await request.get(API + "/api/v1/health")).json();
  expect(health.livePayoutEnabled).toBe(false);
  expect(health.zcashBroadcastEnabled).toBe(false);
});

test("Access Pass hosted checkout: the hosted page completes and the DApp unlocks only via its server", async ({ page, context }) => {
  await installTestWallet(page, { chainId: 8453 });
  await page.goto(DAPP + "/");
  await expect(page.locator("#setup-status")).toHaveText("Connected to ZecOne.");
  for (let i = 0; i < 20; i++) {
    await page.locator("#buy").click();
    await page.locator("#checkout:visible, #buy-error:not(:empty)").first().waitFor();
    if (await page.locator("#checkout").isVisible()) break;
    await page.waitForTimeout(1500);
  }
  await page.locator("#tab-hosted").click();
  const [hosted] = await Promise.all([context.waitForEvent("page"), page.locator("#hosted-link").click()]);
  await hosted.waitForURL(/\/pay\/pay_[0-9a-f]{26}\?t=[0-9a-f]{40}$/);
  await expect(hosted.locator("[data-zecone-checkout]")).toHaveAttribute("data-zecone-checkout", "completed", { timeout: 40_000 });
  await expect(page.locator("#unlocked")).toBeVisible({ timeout: 20_000 });
});

test("Access Pass: forged browser events, stale/replayed/unverified webhooks and expired orders never unlock", async ({ page, request }) => {
  const state = JSON.parse(readFileSync(join(process.env.ZECONE_IT_DIR!, "access-pass.json"), "utf8"));
  const secret: string = state.webhookSecret;
  const apiKey: string = state.apiKey;
  expect(secret).toMatch(/^whsec_/);

  // 1. A browser-only "completed" message is ignored (wrong origin) and cannot unlock.
  await page.goto(DAPP + "/");
  let created = false;
  for (let i = 0; i < 20 && !created; i++) {
    await page.locator("#buy").click();
    await page.locator("#checkout:visible, #buy-error:not(:empty)").first().waitFor();
    created = await page.locator("#checkout").isVisible();
    if (!created) await page.waitForTimeout(1500);
  }
  const order = Object.values(JSON.parse(readFileSync(join(process.env.ZECONE_IT_DIR!, "access-pass.json"), "utf8")).orders as Record<string, { id: string; paymentId: string; status: string; createdAt: number }>).sort((a, b) => b.createdAt - a.createdAt)[0];
  // 2. Cancel it through the merchant API before the demo observer replays it → expired.
  const cancel = await request.post(`${API}/api/v1/payments/${order.paymentId}/cancel`, { headers: { Authorization: `Bearer ${apiKey}` }, data: {} });
  expect(cancel.status()).toBe(200);
  await page.evaluate((id) => window.postMessage({ source: "zecone-checkout", type: "completed", paymentId: id, state: "COMPLETED" }, "*"), order.paymentId);

  // 3. A correctly signed but unverifiable "payment.completed" for the canceled order: the
  //    DApp re-reads the payment from ZecOne, sees EXPIRED and refuses (503 → retried, never unlocked).
  const payload = JSON.stringify({ id: "evt_forged_valid_sig", type: "payment.completed", event: "payment.completed", created: 0, livemode: false, attempt: 1, payment: { id: order.paymentId } });
  const now = Math.floor(Date.now() / 1000);
  const sig = (t: number) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
  const unverified = await request.post(DAPP + "/webhooks/zecone", { data: payload, headers: { "Content-Type": "application/json", "X-ZecOne-Signature": sig(now) } });
  expect(unverified.status()).toBe(503);
  // 4. Stale timestamp (replay window) → rejected.
  const stale = await request.post(DAPP + "/webhooks/zecone", { data: payload, headers: { "Content-Type": "application/json", "X-ZecOne-Signature": sig(now - 600) } });
  expect(stale.status()).toBe(401);
  // 5. Replay of an already-processed real event id → acknowledged as duplicate, no effect.
  const seen = JSON.parse(readFileSync(join(process.env.ZECONE_IT_DIR!, "access-pass.json"), "utf8")).processedEvents as string[];
  expect(seen.length).toBeGreaterThan(0);
  const replayBody = JSON.stringify({ id: seen[0], type: "payment.completed", event: "payment.completed", created: 0, livemode: false, attempt: 2, payment: { id: order.paymentId } });
  const replay = await request.post(DAPP + "/webhooks/zecone", {
    data: replayBody,
    headers: { "Content-Type": "application/json", "X-ZecOne-Signature": `t=${now},v1=${createHmac("sha256", secret).update(`${now}.${replayBody}`).digest("hex")}` },
  });
  expect(await replay.json()).toEqual({ ok: true, duplicate: true });

  // The expired order is reported as such and content stays locked.
  await expect(page.locator("#buy-error")).toContainText("expired", { timeout: 15_000 });
  await expect(page.locator("#unlocked")).toBeHidden();
  const content = await page.request.get(`${DAPP}/api/content?order=${order.id}`);
  expect(content.status()).toBe(403);
});

test("no secrets in browser bundles or pages", async ({ request }) => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(js|css|html|json)$/.test(f.name)) files.push(p);
    }
  };
  walk(".next/static");
  const secrets = /(zk_0{24}_|demo-merchant-secret|whsec_[0-9a-f]{8}|sk_[0-9a-f]{48})/;
  for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(secrets);
  for (const path of ["/", "/checkout", "/dashboard", "/docs"]) {
    const html = await (await request.get(WEB + path)).text();
    expect(html, path).not.toMatch(/zk_0{24}_|demo-merchant-secret/);
  }
  const app = await (await request.get(DAPP + "/app.js")).text();
  expect(app).not.toMatch(secrets);
});
