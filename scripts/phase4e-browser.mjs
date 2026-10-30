// Dedicated real-site browser. No request interception, provider injection or stealth.
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(".state/playwright-browsers");
const { chromium } = await import("playwright");
const extension = resolve("extension"),
  profile = resolve(".state/phase4e-chromium-profile");
const evidence = "docs/phase4e-evidence";
mkdirSync(evidence, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: false,
  viewport: { width: 1440, height: 1000 },
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
});
const worker =
  context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
const extensionId = new URL(worker.url()).host;
writeFileSync(
  `${evidence}/browser.json`,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      browser: context.browser()?.version(),
      extensionId,
      extensionVersion: JSON.parse(
        readFileSync("extension/manifest.json", "utf8"),
      ).version,
      dedicatedProfile: true,
      requestInterception: false,
    },
    null,
    2,
  ),
);
const page = context.pages()[0] || (await context.newPage());
await page.goto("https://opensea.io/", { waitUntil: "domcontentloaded" });
console.log(
  JSON.stringify({
    ready: true,
    browser: context.browser()?.version(),
    extensionId,
    profile,
  }),
);
const snapshot = async (page) => ({
  url: page.url().split("#")[0],
  text: (await page.locator("body").innerText()).slice(0, 18000),
});
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  try {
    const c = JSON.parse(line),
      pages = context.pages(),
      p = pages[c.page ?? 0];
    let result;
    if (c.action === "pages")
      result = pages.map((p, index) => ({ index, url: p.url().split("#")[0] }));
    else if (c.action === "snapshot") result = await snapshot(p);
    else if (c.action === "click") {
      await p
        .getByRole(c.role ?? "button", { name: c.name, exact: true })
        .click({ timeout: 10000 });
      result = await snapshot(p);
    } else if (c.action === "text-click") {
      await p.getByText(c.text, { exact: true }).click({ timeout: 10000 });
      result = await snapshot(p);
    } else if (c.action === "screenshot") {
      if (!/^[a-z0-9-]+$/.test(c.name)) throw Error("Invalid evidence name");
      await p.screenshot({ path: `${evidence}/${c.name}.png`, fullPage: true });
      writeFileSync(
        `${evidence}/${c.name}.txt`,
        JSON.stringify(await snapshot(p), null, 2),
      );
      result = "saved";
    } else if (c.action === "status") {
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/popup.html`);
      await panel.waitForTimeout(200);
      result = await snapshot(panel);
    } else if (c.action === "wallet") {
      const w = await context.newPage();
      await w.goto("http://127.0.0.1:3210");
      result = await snapshot(w);
    } else if (c.action === "pair") {
      const { token } = JSON.parse(
        readFileSync(".secrets/browser-pairing.json", "utf8"),
      );
      await p.getByLabel("Have a local pairing code?").fill(token);
      await p
        .getByRole("button", { name: "Unlock wallet", exact: true })
        .click();
      result = "Local one-use pairing submitted; credential not logged";
    } else if (c.action === "close-page") {
      await p.close();
      result = "closed";
    } else if (c.action === "logs") {
      if (!/^[a-z0-9-]+$/.test(c.name)) throw Error("Invalid evidence name");
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/popup.html`);
      result = await panel.evaluate(() =>
        chrome.runtime.sendMessage({ kind: "status" }),
      );
      writeFileSync(
        `${evidence}/${c.name}.json`,
        JSON.stringify(result, null, 2),
      );
      await panel.close();
    } else if (c.action === "dom")
      result = await p.locator("body").ariaSnapshot();
    else if (c.action === "reload") {
      await p.reload();
      result = await snapshot(p);
    } else if (c.action === "username") {
      if (!/^[a-zA-Z0-9_-]{3,30}$/.test(c.value)) throw Error("Invalid public username");
      await p.getByRole("textbox", {name: "Enter username", exact: true}).fill(c.value);
      result = await snapshot(p);
    } else if (c.action === "quit") {
      await context.close();
      break;
    } else throw Error("Unsupported browser action");
    console.log(JSON.stringify({ ok: true, result }));
  } catch (e) {
    console.log(
      JSON.stringify({ ok: false, error: String(e.message).slice(0, 1200) }),
    );
  }
}
await context.close();
