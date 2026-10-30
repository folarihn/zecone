// Real isolated local backend and public devnet RPC. No route mocks, signatures or broadcasts on Solana.
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
const evidence = process.env.ZECONE_QA_EVIDENCE_DIR ?? "docs/phase7a-evidence";
let cookies: any[], csrf: string;
test.beforeAll(async ({ request, browser }) => {
  const token = JSON.parse(
    readFileSync(
      process.env.ZECONE_PHASE7C_REGRESSION === "1"
        ? ".state/phase7c/regression/pairing.json"
        : process.env.ZECONE_PHASE7B_TEST === "1"
          ? ".state/phase7b/browser/pairing.json"
          : ".state/phase7a/pairing.json",
      "utf8",
    ),
  ).token;
  const paired = await request.post("/api/pair", {
    headers: { Origin: "http://127.0.0.1:3210" },
    data: { token },
  });
  expect(paired.ok()).toBe(true);
  csrf = (await paired.json()).csrf;
  const headers = { Origin: "http://127.0.0.1:3210", "X-ZecOne-CSRF": csrf };
  const challenge = await request.post("/api/challenge", { headers, data: {} });
  expect(challenge.ok()).toBe(true);
  const connect = await request.post("/api/connect", {
    headers,
    data: { id: (await challenge.json()).id, approved: true },
  });
  expect(connect.ok()).toBe(true);
  cookies = (await request.storageState()).cookies;
  writeFileSync(
    `${evidence}/isolated-browser.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        browser: browser.version(),
        account: (await connect.json()).address,
        apiMocking: false,
        solanaSigning: false,
        broadcast: false,
      },
      null,
      2,
    ),
  );
});
test.beforeEach(async ({ context }) => context.addCookies(cookies));
test("isolated backend displays real devnet balance and real simulation, without a submit control", async ({
  page,
}) => {
  await page.goto("/?view=Solana");
  await page.getByRole("button", { name: "Refresh devnet balance" }).click();
  await expect(
    page.getByRole("heading", { name: /SOL \(devnet\)/ }),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Prepare and simulate", exact: true })
    .click();
  await expect(
    page.getByText("AWAITING_EXPLICIT_APPROVAL", { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByRole("button", { name: /broadcast|submit|sign transaction/i }),
  ).toHaveCount(0);
  await page.screenshot({
    path: `${evidence}/real-solana-desktop.png`,
    fullPage: true,
  });
});
test("real isolated Solana mobile view fits and is accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?view=Solana");
  await expect(page.getByLabel("Account", { exact: true })).toHaveValue(/.+/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: `${evidence}/real-solana-mobile.png`,
    fullPage: true,
  });
});
test("isolated HTTP endpoints reject signing, broadcasts, Zcash payment and missing CSRF", async ({
  page,
}) => {
  if (process.env.ZECONE_PHASE7B_TEST === "1") {
    const status = await page.request.get("/api/solana-settlement/status");
    expect(status.ok()).toBe(true);
    const data = await status.json();
    expect(data.orders.length).toBe(1);
    expect(data.orders[0].paymentAddress).toBeUndefined();
    const checkouts = await page.request.get("/api/checkouts");
    const rows = (await checkouts.json()).checkouts;
    expect(rows[0].kind).toBe("solana");
    expect(rows[0].chainId).toBeNull();
    expect(rows[0].paymentAddress).toBeNull();
  }
  await page.goto("/?view=Solana");
  const results = await page.evaluate(async (csrf) => {
    const responses = [];
    for (const path of [
      "solana/sign",
      "solana/broadcast",
      "refund/sign",
      "checkout",
      "pay",
    ]) {
      const r = await fetch("/api/" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ZecOne-CSRF": csrf },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          quoteId: crypto.randomUUID(),
          approved: true,
        }),
      });
      responses.push(r.status);
    }
    const missing = await fetch("/api/solana/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    responses.push(missing.status);
    return responses;
  }, csrf);
  for (const status of results) expect(status).toBeGreaterThanOrEqual(400);
});
