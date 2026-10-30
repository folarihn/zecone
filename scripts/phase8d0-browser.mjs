// Actual sites, unmodified extension, fresh profile. Cancellation only; no auth.
import { chromium } from "playwright";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
mkdirSync(".state/phase8d0", { recursive: true });
const revision = JSON.parse(
  readFileSync("node_modules/playwright-core/browsers.json", "utf8"),
).browsers.find((b) => b.name === "chromium").revision;
const extension = resolve("extension"),
  context = await chromium.launchPersistentContext(
    mkdtempSync(resolve(".state/phase8d0/cancel-browser-")),
    {
      executablePath: resolve(
        `.state/playwright-browsers/chromium-${revision}/chrome-win64/chrome.exe`,
      ),
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
      viewport: { width: 1440, height: 1000 },
    },
  );
const report = {
  at: new Date().toISOString(),
  browser: context.browser().version(),
  freshProfile: true,
  requestInterception: false,
  accountApproval: false,
  signing: false,
  broadcast: false,
  sites: [],
};
try {
  for (const [name, url] of [
    ["OpenSea", "https://opensea.io/"],
    ["Uniswap", "https://app.uniswap.org/"],
  ]) {
    const page = await context.newPage(),
      result = {
        name,
        url,
        loaded: false,
        announcement: false,
        pickerDetected: false,
        localPopup: false,
        cancelled: false,
        accountsHidden: null,
      };
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      result.loaded = true;
      result.announcement = await page.evaluate(() => {
        let found = false;
        const f = (e) => {
          if (e.detail.info.rdns === "local.zecone.wallet") found = true;
        };
        addEventListener("eip6963:announceProvider", f);
        dispatchEvent(new Event("eip6963:requestProvider"));
        removeEventListener("eip6963:announceProvider", f);
        return found;
      });
      const button = page
        .getByRole("button", {
          name: name === "OpenSea" ? "Sign in" : "Connect",
          exact: true,
        })
        .first();
      if (await button.count()) await button.click({ timeout: 8000 });
      const choice = page.getByText("ZecOne Testnet", { exact: true }).first();
      await choice.waitFor({ timeout: 10000 });
      result.pickerDetected = true;
      await page.screenshot({
        path: `.state/phase8d0/${name.toLowerCase()}-final-picker.png`,
      });
      const opened = context
        .waitForEvent("page", { timeout: 10000 })
        .catch(() => null);
      await choice.click({ timeout: 8000 });
      const popup = await opened;
      if (popup) {
        await popup
          .waitForURL("http://127.0.0.1:3210/connect**", { timeout: 8000 })
          .catch(() => {});
        result.localPopup = popup
          .url()
          .startsWith("http://127.0.0.1:3210/connect");
        await popup.close();
        result.cancelled = result.localPopup;
      }
    } catch (e) {
      result.blocker =
        e.name === "TimeoutError"
          ? "SITE_OR_PICKER_TIMEOUT"
          : "SITE_OR_TRANSPORT_UNAVAILABLE";
    }
    try {
      result.accountsHidden = await page.evaluate(async () => {
        let provider;
        const f = (e) => {
          if (e.detail.info.rdns === "local.zecone.wallet")
            provider = e.detail.provider;
        };
        addEventListener("eip6963:announceProvider", f);
        dispatchEvent(new Event("eip6963:requestProvider"));
        removeEventListener("eip6963:announceProvider", f);
        return (
          !!provider &&
          (await provider.request({ method: "eth_accounts" })).length === 0
        );
      });
    } catch {
      /* Unmeasured privacy state remains null, never a fabricated pass. */
    }
    report.sites.push(result);
    await page.close();
  }
} finally {
  await context.close();
}
writeFileSync(
  "docs/phase8d0-evidence/real-sites.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
