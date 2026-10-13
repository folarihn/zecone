// Local browser harness of the distributed provider source. NOT an OpenSea
// connection and NOT proof that the MV3 extension was installed in Edge.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
test("provider browser harness authenticates a separate-origin popup and disconnects", async ({
  page,
  context,
}) => {
  const source = readFileSync("extension/provider.js", "utf8").replace(
    '["https://opensea.io", "https://www.opensea.io"]',
    '["http://127.0.0.1:3211"]',
  );
  await page.route("**/provider-harness", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<button id="connect">Connect local fixture</button><p id="result"></p><script>window.addEventListener('eip6963:announceProvider',e=>window.p=e.detail.provider);</script><script>${source}</script><script>p.on('accountsChanged',a=>document.querySelector('#result').textContent=JSON.stringify(a));document.querySelector('#connect').onclick=()=>p.request({method:'eth_requestAccounts'}).then(a=>document.querySelector('#result').textContent=JSON.stringify(a));</script>`,
    }),
  );
  await context.route("http://127.0.0.1:3210/connect**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<h1>Synthetic signer popup</h1><p id="origin"></p><button id="approve">Approve fixture account</button><button id="revoke">Revoke fixture</button><script>const channel=location.hash.slice(1);let request;const send=m=>opener.postMessage({protocol:'zecone:2',channel,...m},'http://127.0.0.1:3211');addEventListener('message',e=>{if(e.source!==opener||e.origin!=='http://127.0.0.1:3211'||e.data.channel!==channel)return;document.querySelector('#origin').textContent=e.origin;if(e.data.kind==='hello')send({kind:'ready',chainId:'0x14a34'});if(e.data.kind==='request')request=e.data;});document.querySelector('#approve').onclick=()=>send({kind:'response',id:request.id,result:['0x1111111111111111111111111111111111111111']});document.querySelector('#revoke').onclick=()=>send({kind:'event',event:'disconnect'});</script>`,
    }),
  );
  await page.goto("/provider-harness");
  expect(await page.evaluate(() => !!(window as any).p)).toBe(true);
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect local fixture" }).click();
  const popup = await opened;
  await expect(popup.locator("#origin")).toHaveText("http://127.0.0.1:3211");
  await expect(page.locator("#result")).toBeEmpty();
  await popup.getByRole("button", { name: "Approve fixture account" }).click();
  await expect(page.locator("#result")).toContainText(
    "0x1111111111111111111111111111111111111111",
  );
  await popup.getByRole("button", { name: "Revoke fixture" }).click();
  await expect(page.locator("#result")).toHaveText("[]");
});
