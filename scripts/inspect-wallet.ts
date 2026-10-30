// Read-only browser verification of REAL local data. Never clicks a signing action.
import { chromium } from "@playwright/test";
import { readJson } from "../services/execution/io.ts";
import { mkdirSync } from "node:fs";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { token } = readJson<{ token: string }>(
    ".secrets/browser-pairing.json",
  );
  await page.goto(`http://127.0.0.1:3210/#pair=${token}`);
  await page.getByRole("heading", { name: "Wallet overview" }).waitFor();
  await page.waitForFunction(() =>
    document.body.innerText.includes("available to spend"),
  );
  mkdirSync("docs/phase1-evidence", { recursive: true });
  await page.screenshot({
    path: "docs/phase1-evidence/wallet-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/phase1-evidence/wallet-mobile.png",
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      pageErrors: errors,
      title: await page.title(),
      mobileOverflow: await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    }),
  );
} finally {
  await browser.close();
}
