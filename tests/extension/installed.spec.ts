// Actual installed MV3 extension, independent local website and SYNTHETIC signer.
// These tests never constitute real OpenSea/account/signature evidence.
import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { cpSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
const fixtureOrigin = "http://127.0.0.1:3212",
  walletOrigin = "http://127.0.0.1:3210";
const account = "0x1111111111111111111111111111111111111111";
const root = resolve(".state/phase4e-fixture-extension");
cpSync("extension", root, { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
for (const script of manifest.content_scripts)
  script.matches = [fixtureOrigin + "/*"];
writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
for (const file of ["inpage.js", "content.js", "policy.js"])
  writeFileSync(
    join(root, file),
    readFileSync(join(root, file), "utf8").replace(
      file === "policy.js"
        ? 'new URL(origin).protocol !== "https:"'
        : '!location.origin.startsWith("https://")',
      file === "policy.js"
        ? `origin !== ${JSON.stringify(fixtureOrigin)}`
        : `location.origin !== ${JSON.stringify(fixtureOrigin)}`,
    ),
  );
const revision = JSON.parse(
  readFileSync("node_modules/playwright-core/browsers.json", "utf8"),
).browsers.find((b: any) => b.name === "chromium").revision;
const executablePath = resolve(
  `.state/playwright-browsers/chromium-${revision}/chrome-win64/chrome.exe`,
);
let context: BrowserContext, page: Page, profile: string;
const options = {
  executablePath,
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
};
async function routes() {
  await context.route(fixtureOrigin + "/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<h1>Independent synthetic dApp</h1><button id="connect">Connect fixture</button><p id="result"></p><script>addEventListener('eip6963:announceProvider',e=>{window.p=e.detail.provider;window.info=e.detail.info});dispatchEvent(new Event('eip6963:requestProvider'));window.start=(method,params=[])=>{window.result=undefined;return p.request({method,params}).then(v=>{window.result={value:v};document.querySelector('#result').textContent=JSON.stringify(window.result)},e=>{window.result={error:e.code};document.querySelector('#result').textContent=JSON.stringify(window.result)})};document.querySelector('#connect').onclick=()=>start('eth_requestAccounts');</script>`,
    }),
  );
  await context.route(walletOrigin + "/connect**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<h1>SYNTHETIC approval — no real keys</h1><p id="origin"></p><p id="method"></p><button id="approve">Approve fixture</button><button id="reject">Reject fixture</button><button id="expire">Expire session fixture</button><script>const channel=location.hash.slice(1);let request,authorized=false,chainId='0x14a34';const send=m=>opener.postMessage({protocol:'zecone:2',channel,...m},'${fixtureOrigin}');const respond=(result,error)=>send({kind:'response',id:request.id,...(error?{error}:{result})});addEventListener('message',e=>{if(e.source!==opener||e.origin!=='${fixtureOrigin}'||e.data.channel!==channel)return;document.querySelector('#origin').textContent=e.origin;if(e.data.kind==='hello')send({kind:'ready',chainId});if(e.data.kind==='request'){request=e.data;document.querySelector('#method').textContent=request.method;if(request.method==='eth_accounts')respond(authorized?['${account}']:[]);if(request.method==='eth_chainId')respond(chainId);if(request.method==='wallet_revokePermissions'){authorized=false;respond(null);send({kind:'event',event:'accountsChanged',value:[]})}}});document.querySelector('#approve').onclick=()=>{if(request.method==='eth_requestAccounts'){authorized=true;respond(['${account}']);send({kind:'event',event:'accountsChanged',value:['${account}']})}else if(request.method==='wallet_switchEthereumChain'){chainId=request.params[0].chainId;respond(null);send({kind:'event',event:'chainChanged',value:chainId})}else respond('0x'+'ab'.repeat(65))};document.querySelector('#reject').onclick=()=>respond(null,{code:4001,message:'User rejected fixture'});document.querySelector('#expire').onclick=()=>send({kind:'event',event:'disconnect'});</script>`,
    }),
  );
}
test.beforeEach(async () => {
  profile = mkdtempSync(resolve(".state/phase4e-test-profile-"));
  context = await chromium.launchPersistentContext(profile, options);
  await routes();
  page = await context.newPage();
  await page.goto(fixtureOrigin);
  await expect.poll(() => page.evaluate(() => !!(window as any).p)).toBe(true);
});
test.afterEach(async () => {
  await context.close();
});
async function connect(approve = true) {
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Connect fixture" }).click();
  const popup = await opened;
  await expect(popup.locator("#method")).toHaveText("eth_requestAccounts");
  if (approve) {
    await popup
      .getByRole("button", { name: "Approve fixture", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).result))
      .toEqual({ value: [account] });
  }
  return popup;
}
const rpc = (method: string, params: any[] = []) =>
  page.evaluate(
    async ({ method, params }) => {
      try {
        return { value: await (window as any).p.request({ method, params }) };
      } catch (e: any) {
        return { error: e.code };
      }
    },
    { method, params },
  );

test("unmodified production extension discovers independently on two HTTPS fixture origins", async () => {
  const productionRoot = resolve("extension");
  const isolated = await chromium.launchPersistentContext(
    mkdtempSync(resolve(".state/phase6-https-profile-")),
    {
      ...options,
      args: [
        `--disable-extensions-except=${productionRoot}`,
        `--load-extension=${productionRoot}`,
      ],
    },
  );
  try {
    await isolated.route("https://*.zecone.invalid/**", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<h1>Synthetic HTTPS provider fixture</h1><script>window.addEventListener('eip6963:announceProvider',e=>{window.p=e.detail.provider;window.info=e.detail.info});window.dispatchEvent(new Event('eip6963:requestProvider'));</script>`,
      }),
    );
    for (const origin of [
      "https://alpha.zecone.invalid",
      "https://beta.zecone.invalid",
    ]) {
      const p = await isolated.newPage();
      await p.goto(origin);
      await expect.poll(() => p.evaluate(() => !!(window as any).p)).toBe(true);
      expect(await p.evaluate(() => (window as any).info.name)).toBe(
        "ZecOne Testnet",
      );
      expect(
        await p.evaluate(() =>
          (window as any).p.request({ method: "eth_accounts" }),
        ),
      ).toEqual([]);
      expect(
        await p.evaluate(async () => {
          try {
            await (window as any).p.request({
              method: "eth_sendTransaction",
              params: [{ chainId: "0x1" }],
            });
            return 0;
          } catch (e: any) {
            return e.code;
          }
        }),
      ).toBe(4901);
      await p.close();
    }
  } finally {
    await isolated.close();
  }
});

test("installed MV3 worker and independent EIP-6963 discovery with no impersonation", async () => {
  expect(context.serviceWorkers()[0].url()).toContain("background.js");
  expect(
    await page.evaluate(() => ({
      name: (window as any).info.name,
      frozen: Object.isFrozen((window as any).p),
      ethereum: !!(window as any).ethereum,
    })),
  ).toEqual({ name: "ZecOne Testnet", frozen: true, ethereum: false });
  expect(await rpc("eth_accounts")).toEqual({ value: [] });
});
test("request routing binds actual website origin and waits for account approval", async () => {
  const popup = await connect(false);
  await expect(popup.locator("#origin")).toHaveText(fixtureOrigin);
  expect(await page.evaluate(() => (window as any).result)).toBeUndefined();
  await popup
    .getByRole("button", { name: "Approve fixture", exact: true })
    .click();
  await expect.poll(() => rpc("eth_accounts")).toEqual({ value: [account] });
});
test("unauthorized signing and private RPCs cannot open a signer", async () => {
  for (const method of [
    "personal_sign",
    "eth_signTypedData_v4",
    "eth_sendTransaction",
  ])
    expect(await rpc(method)).toEqual({ error: 4100 });
  for (const method of [
    "zcash_getBalance",
    "zcash_exportViewingKey",
    "wallet_exportPrivateKey",
    "eth_sendRawTransaction",
    "eth_sign",
  ])
    expect(await rpc(method)).toEqual({ error: 4200 });
  expect(context.pages()).toHaveLength(2);
});
test("repeated connection request is rejected while approval is pending", async () => {
  await connect(false);
  expect(await rpc("eth_requestAccounts")).toEqual({ error: -32002 });
});
test("reject then explicitly approve supported synthetic message signing", async () => {
  const popup = await connect();
  let result = rpc("personal_sign", ["0x6869", account]);
  await expect(popup.locator("#method")).toHaveText("personal_sign");
  await popup
    .getByRole("button", { name: "Reject fixture", exact: true })
    .click();
  expect(await result).toEqual({ error: 4001 });
  result = rpc("personal_sign", ["0x6869", account]);
  await popup
    .getByRole("button", { name: "Approve fixture", exact: true })
    .click();
  expect(await result).toEqual({ value: "0x" + "ab".repeat(65) });
});
test("malicious webpage cannot impersonate the isolated wallet-response source", async () => {
  await connect(false);
  await page.evaluate(() => {
    window.postMessage(
      { protocol: "zecone:2", kind: "ready", chainId: "0x14a34" },
      location.origin,
    );
    window.postMessage(
      {
        protocol: "zecone:extension:1",
        direction: "request",
        kind: "wallet",
        approved: true,
        origin: "https://trusted.example",
        message: {
          kind: "response",
          result: ["0x1111111111111111111111111111111111111111"],
        },
      },
      location.origin,
    );
  });
  expect(await rpc("eth_accounts")).toEqual({ value: [] });
  expect(await rpc("personal_sign")).toEqual({ error: 4100 });
});
test("network approval emits chainChanged and mainnet requests fail closed", async () => {
  const popup = await connect();
  await page.evaluate(() =>
    (window as any).p.on(
      "chainChanged",
      (c: string) => ((window as any).changed = c),
    ),
  );
  const result = rpc("wallet_switchEthereumChain", [{ chainId: "0xaa36a7" }]);
  await expect(popup.locator("#method")).toHaveText(
    "wallet_switchEthereumChain",
  );
  await popup
    .getByRole("button", { name: "Approve fixture", exact: true })
    .click();
  expect(await result).toEqual({ value: null });
  await expect
    .poll(() => page.evaluate(() => (window as any).changed))
    .toBe("0xaa36a7");
  for (const method of [
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "eth_sendTransaction",
  ])
    expect(await rpc(method, [{ chainId: "0x1" }])).toEqual({ error: 4901 });
});
test("revocation removes account access and blocks further signing", async () => {
  await connect();
  expect(await rpc("wallet_revokePermissions", [{ eth_accounts: {} }])).toEqual(
    { value: null },
  );
  expect(await rpc("eth_accounts")).toEqual({ value: [] });
  expect(await rpc("personal_sign")).toEqual({ error: 4100 });
});
test("popup closure rejects pending approval and disconnects", async () => {
  const popup = await connect(false);
  await popup.close();
  await expect
    .poll(() => page.evaluate(() => (window as any).result))
    .toEqual({ error: 4900 });
  expect(await rpc("eth_accounts")).toEqual({ value: [] });
});
test("session expiry/local signer disconnection rejects pending signing", async () => {
  const popup = await connect();
  const result = rpc("personal_sign", ["0x6869", account]);
  await expect(popup.locator("#method")).toHaveText("personal_sign");
  await popup.getByRole("button", { name: "Expire session fixture" }).click();
  expect(await result).toEqual({ error: 4900 });
  expect(await rpc("eth_accounts")).toEqual({ value: [] });
});
test("browser restart cannot retain approved transport or replay requests", async () => {
  await connect();
  await context.close();
  context = await chromium.launchPersistentContext(profile, options);
  await routes();
  page = await context.newPage();
  await page.goto(fixtureOrigin);
  expect(await rpc("eth_accounts")).toEqual({ value: [] });
  expect(await rpc("personal_sign")).toEqual({ error: 4100 });
});
test("service worker termination disconnects and requires fresh account access", async () => {
  await connect();
  const cdp = await context.newCDPSession(page);
  let versions: any[] = [];
  cdp.on("ServiceWorker.workerVersionUpdated", (e: any) =>
    versions.push(...e.versions),
  );
  await cdp.send("ServiceWorker.enable");
  await expect
    .poll(() => versions.some((v) => v.scriptURL.endsWith("/background.js")))
    .toBe(true);
  const worker = versions.findLast(
    (v) =>
      v.scriptURL.endsWith("/background.js") && v.runningStatus === "running",
  );
  await cdp.send("ServiceWorker.stopWorker", { versionId: worker.versionId });
  await expect.poll(() => rpc("eth_accounts")).toEqual({ value: [] });
  expect(await rpc("personal_sign")).toEqual({ error: 4100 });
});

test("extension action displays account and pending status and disconnects transport", async () => {
  await connect();
  const worker = context.serviceWorkers()[0],
    id = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/popup.html`);
  await expect(panel.locator("#connections")).toContainText(account);
  await expect(panel.locator("#connections")).toContainText("Base Sepolia");
  await expect(panel.locator("#connections")).toContainText("0 pending");
  await panel.getByRole("button", { name: "Disconnect transport" }).click();
  await expect(panel.locator("#connections")).toContainText(
    "Disconnected. Open a compatible HTTPS dApp",
  );
  await expect.poll(() => rpc("eth_accounts")).toEqual({ value: [] });
  expect(await rpc("personal_sign")).toEqual({ error: 4100 });
  await expect(
    panel.getByRole("link", { name: "Open wallet · manage saved permissions" }),
  ).toHaveAttribute("href", walletOrigin);
});
