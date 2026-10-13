// Pair the actual local browser and approve an ownership proof; no funds sent.
import { chromium, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { readJson } from "../services/execution/io.ts";
const { token } = readJson<{ token: string }>(".secrets/browser-pairing.json");
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext(),
    page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:3210/#pair=${token}`);
  try {
    await expect(
      page.getByRole("heading", { name: "Wallet overview" }),
    ).toBeVisible({ timeout: 30000 });
  } catch (e) {
    writeFileSync(
      ".state/phase4a-browser-diagnostic.txt",
      JSON.stringify(
        { errors, text: await page.locator("body").innerText() },
        null,
        2,
      ),
    );
    throw Error("Wallet page failed; see private diagnostic");
  }
  await page
    .getByRole("button", { name: "Verify ownership", exact: true })
    .last()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Approve connection signature" })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 30000 });
  await context.storageState({ path: ".secrets/phase4a-browser-session.json" });
  console.log(
    "Phase 4A browser paired and user EOA ownership verified locally.",
  );
} finally {
  await browser.close();
}
