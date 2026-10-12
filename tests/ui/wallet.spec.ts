// UI-only synthetic fixtures. All API requests intercepted; never spend real assets.
import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
const fixture = {
  address: "0x1111111111111111111111111111111111111111",
  contract: "0x2222222222222222222222222222222222222222",
  priceZatoshis: "1000000",
  zcash: {
    totalZatoshis: "11480000",
    spendableZatoshis: "11480000",
    tip: 4491431,
    scanned: 4491431,
    observedAt: 1791790421,
    history: [
      {
        txid: "a".repeat(64),
        height: 4491375,
        deltaZatoshis: "-1020000",
        feeZatoshis: "20000",
        time: 1791788771,
        expired: false,
      },
    ],
  },
  base: { wei: "10000000000000000", block: "48010357", observedAt: 1791790421 },
  health: { zcash: "Synced", base: "Connected", worker: "Ready", busy: false },
  nfts: [
    {
      tokenId: "123456789",
      hash: `0x${"b".repeat(64)}`,
      verifiedAt: 1791790421,
    },
  ],
  baseActivity: [
    { hash: `0x${"b".repeat(64)}`, status: "Confirmed", kind: "mint", tokenId: "123456789" },
  ],
  checkouts: [],
};
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown =
      path === "/api/session"
        ? { csrf: "fixture", connected: true }
        : path === "/api/dashboard"
          ? fixture
          : path === "/api/dapps/list"
            ? { connections: [{ origin: "https://fixture.example", created: 1791790421000 }], requests: [] }
            : path === "/api/action-draft"
              ? { id: "draft", digest: "digest", description: "Fixed action only.", intent: { recipient: fixture.address, contract: fixture.contract, target: fixture.contract, data: "0x1234", value: "0", maxValue: "0", maxGasBudget: "5000000000000000", zatoshis: "1000000", expiry: Math.floor(Date.now()/1000)+3600 } }
              : {};
    if (path === "/api/challenge")
      body = {
        id: "fixture-challenge",
        message: "Synthetic ownership challenge — test only",
      };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
});
test("desktop wallet is accessible and has no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Wallet overview" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});
test("mobile navigation, checkout review and focus-trapped approval are accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Wallet overview" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Checkout", exact: true })
    .click();
  await page.getByRole("button", { name: "Review & create order" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve & sign order" }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest("dialog")),
  ).toBe(true);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Privacy", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Base is public" }),
  ).toBeVisible();
});
test("no signing happens merely by visiting checkout or opening an approval", async ({
  page,
}) => {
  const signing: string[] = [];
  page.on("request", (req) => {
    if (
      ["/api/pay", "/api/checkout", "/api/connect"].includes(
        new URL(req.url()).pathname,
      )
    )
      signing.push(req.url());
  });
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Checkout", exact: true })
    .click();
  await page.getByRole("button", { name: "Review & create order" }).click();
  await page.getByRole("button", { name: "Close dialog" }).click();
  expect(signing).toEqual([]);
});
test("sponsor screen displays fixed terms before its explicit approval", async ({page})=>{
 const posts:string[]=[];page.on("request",r=>{if(r.method()==="POST")posts.push(new URL(r.url()).pathname);});
 await page.goto("/");await page.getByRole("navigation").getByRole("button",{name:"Sponsor",exact:true}).click();
 await page.getByRole("button",{name:"Review fixed action terms"}).click();await expect(page.getByText(/ZEC payment is a testnet service price/)).toBeVisible();
 await expect(page.getByText("0.005 ETH execution cap; Base L1 data fees may be additional")).toBeVisible();
 expect(posts).toContain("/api/action-draft");expect(posts).not.toContain("/api/action-approve");
 await page.getByRole("button",{name:"Approve these exact terms"}).click();
 await expect.poll(()=>posts.includes("/api/action-approve")).toBe(true);
});
test("apps page names exact origins and lets the user revoke a connection",async({page})=>{
 const posts:string[]=[];page.on("request",r=>{if(r.method()==="POST")posts.push(new URL(r.url()).pathname);});
 await page.goto("/");await page.getByRole("navigation").getByRole("button",{name:"Apps",exact:true}).click();await page.getByRole("button",{name:"Refresh list"}).click();
 await expect(page.getByText("https://fixture.example",{exact:true})).toBeVisible();await page.getByRole("button",{name:"Disconnect"}).click();
 expect(posts).toContain("/api/dapps/revoke");
});
