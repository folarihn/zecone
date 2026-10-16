// Installed extension, synthetic HTTPS dApp and popup. No live website claim.
import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
const origin = "https://phase7a.fixture.invalid",
  wallet = "http://127.0.0.1:3210";
const revision = JSON.parse(
  readFileSync("node_modules/playwright-core/browsers.json", "utf8"),
).browsers.find((b: any) => b.name === "chromium").revision;
let context: BrowserContext, page: Page;
test.beforeEach(async () => {
  mkdirSync(".state/phase7a", { recursive: true });
  const root = resolve("extension");
  context = await chromium.launchPersistentContext(
    mkdtempSync(resolve(".state/phase7a/browser-")),
    {
      executablePath: resolve(
        `.state/playwright-browsers/chromium-${revision}/chrome-win64/chrome.exe`,
      ),
      headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    },
  );
  await context.route(origin + "/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<h1>Synthetic Solana dApp</h1><button id="connect">Connect</button><script>dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:{register:w=>window.wallet=w}}));document.querySelector('#connect').onclick=()=>wallet.features['standard:connect'].connect().then(r=>window.result=r,e=>window.failure=e.code);</script>`,
    }),
  );
  await context.route(wallet + "/solana-connect**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<h1>Synthetic Solana approval</h1><button id="approve">Approve fixture</button><button id="reject">Reject</button><script>const channel=location.hash.slice(1);const send=(result,error)=>opener.postMessage({protocol:'zecone:solana:1',channel,kind:'response',result,error},'${origin}');addEventListener('message',e=>{if(e.origin!=='${origin}'||e.source!==opener||e.data.channel!==channel)return;window.method=e.data.method;});document.querySelector('#approve').onclick=()=>send({address:'11111111111111111111111111111111',publicKey:Array(32).fill(0)});document.querySelector('#reject').onclick=()=>send(null,{code:4001,message:'Fixture rejection'});setInterval(()=>opener.postMessage({protocol:'zecone:solana:1',channel,kind:'ready'},'${origin}'),100);</script>`,
    }),
  );
  page = await context.newPage();
  await page.goto(origin);
});
test.afterEach(async () => context.close());
test("installed Wallet Standard announces ZecOne and connects only after popup approval", async () => {
  expect(await page.evaluate(() => (window as any).wallet.name)).toBe("ZecOne");
  expect(
    await page.evaluate(() => (window as any).wallet.accounts.length),
  ).toBe(0);
  const popupEvent = context.waitForEvent("page");
  await page.locator("#connect").click();
  const popup = await popupEvent;
  await popup.locator("#approve").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).result?.accounts.length))
    .toBe(1);
  expect(await page.evaluate(() => (window as any).wallet.chains)).toEqual([
    "solana:devnet",
  ]);
  expect(
    await page.evaluate(() =>
      Boolean((window as any).wallet.features["solana:signAndSendTransaction"]),
    ),
  ).toBe(false);
});
test("installed Wallet Standard rejection returns 4001 and grants no account", async () => {
  const popupEvent = context.waitForEvent("page");
  await page.locator("#connect").click();
  const popup = await popupEvent;
  await popup.locator("#reject").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).failure))
    .toBe(4001);
  expect(
    await page.evaluate(() => (window as any).wallet.accounts.length),
  ).toBe(0);
});
test("installed Wallet Standard ignores forged website responses and rejects mainnet before popup", async () => {
  const popupEvent = context.waitForEvent("page");
  await page.locator("#connect").click();
  const popup = await popupEvent;
  await page.evaluate(() =>
    window.postMessage(
      {
        protocol: "zecone:solana:1",
        kind: "response",
        result: { address: "attacker" },
      },
      location.origin,
    ),
  );
  expect(
    await page.evaluate(() => (window as any).wallet.accounts.length),
  ).toBe(0);
  await popup.locator("#approve").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).wallet.accounts.length))
    .toBe(1);
  const code = await page.evaluate(async () => {
    const w = (window as any).wallet;
    try {
      await w.features["solana:signTransaction"].signTransaction({
        account: w.accounts[0],
        chain: "solana:mainnet",
        transaction: new Uint8Array([1]),
      });
    } catch (e: any) {
      return e.code;
    }
  });
  expect(code).toBe(4901);
});
