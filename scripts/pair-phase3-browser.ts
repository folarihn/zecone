// Creates a fresh local browser session after the prior run's saved cookie expires.
// Pairing capability remains private; ownership approval is shown in the real UI.
import { chromium, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { readJson } from "../services/execution/io.ts";
if (!existsSync(".secrets/browser-pairing.json"))
  throw Error(
    "Local launcher pairing capability is unavailable; reopen the wallet launcher.",
  );
const { token } = readJson<{ token: string }>(".secrets/browser-pairing.json");
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.goto(`http://127.0.0.1:3210/#pair=${token}`);
  await expect(
    page.getByRole("heading", { name: "Wallet overview" }),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Verify ownership", exact: true })
    .last()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Approve connection signature" })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 30000 });
  await context.storageState({ path: ".secrets/phase3-browser-session.json" });
  console.log(
    "Fresh local Phase 3 browser session paired and ownership-verified.",
  );
} finally {
  await browser.close();
}
