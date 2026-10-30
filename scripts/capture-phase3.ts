// Read-only screenshots of the real wallet and the same marketplace purchase.
import { chromium, expect } from "@playwright/test";
import { readJson } from "../services/execution/io.ts";
const label = process.argv[2];
if (!["pending", "completed", "restarted"].includes(label))
  throw Error("Choose pending, completed, or restarted");
const { purchaseId } = readJson<{ purchaseId: string }>(
  ".state/phase3-live-started.json",
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({
      storageState: ".secrets/phase3-browser-session.json",
      viewport: { width: 1440, height: 1050 },
    }),
    wallet = await context.newPage();
  await wallet.goto("http://127.0.0.1:3210/");
  await wallet
    .getByRole("navigation")
    .getByRole("button", { name: "Purchases", exact: true })
    .click();
  await expect(
    wallet.getByRole("heading", { name: "Marketplace purchases", exact: true }),
  ).toBeVisible();
  const actual = await wallet.evaluate(async (id) => {
    const data = await (
      await fetch("/api/purchases/list", { cache: "no-store" })
    ).json();
    return data.purchases.find((r: any) => r.id === id);
  }, purchaseId);
  if (!actual) throw Error("Purchase missing");
  if (
    label !== "pending" &&
    (!actual.ownerVerified || actual.status !== "Completed")
  )
    throw Error("Completion not verified");
  await expect(
    wallet.getByRole("heading", { name: actual.status, exact: true }).first(),
  ).toBeVisible();
  await wallet.screenshot({
    path: `docs/phase3-evidence/wallet-${label}.png`,
    fullPage: true,
  });
  await context.addInitScript(
    ({ purchaseId }) => {
      if (location.origin === "http://127.0.0.1:4322")
        localStorage.setItem("zecone:purchase", purchaseId);
    },
    { purchaseId },
  );
  const market = await context.newPage();
  await market.goto("http://127.0.0.1:4322");
  await market
    .getByRole("button", { name: "Connect ZecOne", exact: true })
    .click();
  await expect(market.locator("#status")).toHaveText(actual.status, {
    timeout: 60000,
  });
  await market.screenshot({
    path: `docs/phase3-evidence/marketplace-${label}.png`,
    fullPage: true,
  });
  await wallet.setViewportSize({ width: 390, height: 844 });
  await wallet.screenshot({
    path: `docs/phase3-evidence/wallet-${label}-mobile.png`,
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      captured: label,
      status: actual.status,
      ownerVerified: actual.ownerVerified,
      confirmations: actual.confirmations,
      purchaseId,
    }),
  );
} catch {
  console.error(
    "Live screenshot verification stopped; no fabricated status was captured.",
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
