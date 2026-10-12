// Opt-in, REAL testnet browser exercise. Not part of npm test or UI fixture tests.
// The one-run marker prevents invoking start twice and accidentally buying another NFT.
import { chromium, expect } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { exclusiveJson, readJson } from "../services/execution/io.ts";
import type { Dashboard } from "../services/wallet/view.ts";
const mode = process.argv[2];
if (!["start", "status"].includes(mode ?? ""))
  throw Error("Use start --allow-testnet-spend or status.");
if (mode === "start") {
  if (!process.argv.includes("--allow-testnet-spend"))
    throw Error("Explicit real testnet approval required.");
  exclusiveJson(".state/phase1-live-ui-started.json", {
    startedAt: new Date().toISOString(),
    description: "One authorized UI checkout, 0.01 TAZ plus reviewed fee.",
  });
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    ...(mode === "status" && existsSync(".secrets/phase1-browser-session.json")
      ? { storageState: ".secrets/phase1-browser-session.json" }
      : {}),
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  mkdirSync("docs/phase1-evidence", { recursive: true });
  if (mode === "start") {
    const { token } = readJson<{ token: string }>(
      ".secrets/browser-pairing.json",
    );
    await page.goto(`http://127.0.0.1:3210/#pair=${token}`);
    await expect(
      page.getByRole("heading", { name: "Wallet overview" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Verify ownership", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({
      path: "docs/phase1-evidence/ownership-approval.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Approve connection signature" })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 30000 });
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Checkout", exact: true })
      .click();
    await page.getByRole("button", { name: "Review & create order" }).click();
    await page.screenshot({
      path: "docs/phase1-evidence/order-approval.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Approve & sign order" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 120000 });
    await page.getByRole("button", { name: "Review payment & fee" }).click();
    await expect(
      page.getByRole("heading", { name: "Approve shielded payment" }),
    ).toBeVisible({ timeout: 120000 });
    const review = await page.getByRole("dialog").innerText();
    exclusiveJson("docs/phase1-evidence/approved-payment-review.json", {
      approvedAt: new Date().toISOString(),
      review,
    });
    await page.screenshot({
      path: "docs/phase1-evidence/payment-approval.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Approve & send test ZEC" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 30000 });
    await context.storageState({
      path: ".secrets/phase1-browser-session.json",
    });
  } else {
    await page.goto("http://127.0.0.1:3210/");
    await expect(
      page.getByRole("heading", { name: "Wallet overview" }),
    ).toBeVisible();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Checkout", exact: true })
      .click();
  }
  const d = (await page.evaluate(
    async () => await (await fetch("/api/dashboard")).json(),
  )) as Dashboard;
  const c = d.checkouts[0];
  if (!c) throw Error("No real checkout found.");
  await page.screenshot({
    path: `docs/phase1-evidence/checkout-${c.status === "Completed" ? "completed" : "progress"}.png`,
    fullPage: true,
  });
  if (c.status === "Completed") {
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Wallet", exact: true })
      .click();
    await page.screenshot({
      path: "docs/phase1-evidence/wallet-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "docs/phase1-evidence/wallet-mobile.png",
      fullPage: true,
    });
  }
  const evidence = {
    observedAt: new Date().toISOString(),
    checkout: c,
    address: d.address,
    contract: d.contract,
    zcash: d.zcash
      ? {
          totalZatoshis: d.zcash.totalZatoshis,
          spendableZatoshis: d.zcash.spendableZatoshis,
          tip: d.zcash.tip,
        }
      : null,
    nfts: d.nfts,
    health: d.health,
    pageErrors: errors,
  };
  writeFileSync(
    "docs/phase1-evidence/live-ui.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} catch (e) {
  writeFileSync(
    ".state/browser-error.log",
    e instanceof Error ? (e.stack ?? e.message) : "Unknown browser error",
  );
  console.error(
    "Browser exercise stopped. No further approval was issued. Inspect the local checkout and preserved evidence before resuming.",
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
