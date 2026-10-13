// Read-only screenshots from real wallet state. Never alters displayed balances.
import { chromium, expect } from "@playwright/test";
import { readJson } from "../services/execution/io.ts";
import { network } from "../services/evm/networks.ts";
const id = Number(process.argv[2]),
  n = network(id),
  label = process.argv[3] ?? "completed";
if (id === 84532 || !["pending", "completed", "restarted"].includes(label))
  throw Error("Invalid evidence target");
const { purchaseId } = readJson<{ purchaseId: string }>(
  `.state/phase4a-live-${id}.json`,
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({
      storageState: ".secrets/phase4a-browser-session.json",
      viewport: { width: 1440, height: 1050 },
    }),
    page = await context.newPage();
  await page.goto("http://127.0.0.1:3210/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Purchases", exact: true })
    .click();
  const actual = await page.evaluate(async (id) => {
    const d = await (
      await fetch("/api/purchases/list", { cache: "no-store" })
    ).json();
    return d.purchases.find((p: any) => p.id === id);
  }, purchaseId);
  if (
    !actual ||
    actual.chainId !== id ||
    (label !== "pending" &&
      (!actual.ownerVerified || actual.status !== "Completed"))
  )
    throw Error("Live completion not verified");
  await expect(
    page
      .locator("article")
      .filter({ hasText: n.name })
      .getByRole("heading", { name: actual.status, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `docs/phase4a-evidence/${id}/wallet-${label}.png`,
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      chainId: id,
      purchaseId,
      status: actual.status,
      confirmations: actual.confirmations,
      ownerVerified: actual.ownerVerified,
      captured: label,
    }),
  );
} finally {
  await browser.close();
}
