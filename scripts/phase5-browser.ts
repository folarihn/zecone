// Real local backend, no route interception, no fabricated state and no asset approvals.
import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const result: Record<string, unknown> = {
  at: new Date().toISOString(),
  kind: "real-backend-read-only-and-cancelled-quote",
  paymentsApproved: 0,
  refundsBroadcast: 0,
};
try {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    }),
    page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("page_runtime_error"));
  await page.goto("http://127.0.0.1:3210/");
  await page.screenshot({
    path: "docs/phase5-evidence/real-locked.png",
    fullPage: true,
  });
  result.unauthenticatedApiStatus = await page.evaluate(
    async () => (await fetch("/api/reference-prices")).status,
  );
  const { token } = JSON.parse(
    readFileSync(".secrets/browser-pairing.json", "utf8"),
  );
  await page
    .getByLabel("Have a local pairing code?", { exact: true })
    .fill(token);
  await page
    .getByRole("button", { name: "Unlock wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Wallet overview" }),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Verify ownership", exact: true })
    .last()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Approve connection signature", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 30000 });
  result.localOwnershipVerified = true;
  const refs = await page.evaluate(async () => {
    const r = await fetch("/api/reference-prices", { cache: "no-store" });
    const b = await r.json();
    return {
      status: r.status,
      referenceOnly: b.referenceOnly,
      sources: b.zec?.sources?.map((p: any) => p.source),
    };
  });
  result.marketReference = refs;
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Privacy", exact: true })
    .click();
  await page.screenshot({
    path: "docs/phase5-evidence/real-privacy.png",
    fullPage: true,
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Tokens", exact: true })
    .click();
  const quoteButton = page.getByRole("button", {
    name: "Get AMM quote",
    exact: true,
  });
  try {
    await expect(quoteButton).toBeVisible({ timeout: 60000 });
    await quoteButton.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 60000 });
    await expect(
      page.getByRole("region", { name: "Unified checkout terms" }),
    ).toBeVisible();
    await page.screenshot({
      path: "docs/phase5-evidence/real-token-review-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "docs/phase5-evidence/real-token-review-mobile.png",
      fullPage: true,
    });
    result.mobileNoHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    result.tokenQuote =
      "actual simulated-testnet quote reviewed then cancelled; no intent or payment signed";
  } catch {
    result.tokenQuote = "unavailable; no approval or payment attempted";
    await page.screenshot({
      path: "docs/phase5-evidence/real-token-unavailable.png",
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  const historical = page
    .getByText("Historical approved terms", { exact: true })
    .first();
  if (await historical.count()) {
    await historical.click();
    await expect(
      page.getByRole("region", { name: "Unified checkout terms" }).first(),
    ).toBeVisible();
    await page.screenshot({
      path: "docs/phase5-evidence/real-historical-terms-desktop.png",
      fullPage: true,
      mask: [page.locator("details dd.break")],
    });
    await page.setViewportSize({ width: 390, height: 844 });
    result.historicalTermsNoHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    );
    await page.screenshot({
      path: "docs/phase5-evidence/real-historical-terms-mobile.png",
      fullPage: true,
      mask: [page.locator("details dd.break")],
    });
    result.historicalTerms =
      "actual prior completed swap; addresses masked in screenshot; no new settlement";
    await page.setViewportSize({ width: 1440, height: 1050 });
  }
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Seaport", exact: true })
    .click();
  await expect(page.getByLabel("OpenSea NFT URL", { exact: true })).toBeVisible(
    { timeout: 30000 },
  );
  await page
    .getByLabel("OpenSea NFT URL", { exact: true })
    .fill(
      "https://opensea.io.evil.example/item/ethereum/0x1111111111111111111111111111111111111111/1",
    );
  await page
    .getByRole("button", {
      name: "Import URL for inspection only",
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "exact OpenSea Ethereum NFT URL" }),
  ).toBeVisible({ timeout: 30000 });
  result.maliciousImportRejected = true;
  await page.screenshot({
    path: "docs/phase5-evidence/real-import-rejected.png",
    fullPage: true,
  });
  const session = await page.evaluate(async () => {
    const s = await (await fetch("/api/session", { cache: "no-store" })).json();
    const r = await fetch("/api/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ZecOne-CSRF": s.csrf },
      body: "{}",
    });
    return r.status;
  });
  result.disconnectStatus = session;
  result.afterDisconnectApiStatus = await page.evaluate(
    async () => (await fetch("/api/reference-prices")).status,
  );
  result.pageErrors = errors;
} finally {
  await browser.close();
  writeFileSync(
    "docs/phase5-evidence/real-browser.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}
