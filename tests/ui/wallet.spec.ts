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
    {
      hash: `0x${"b".repeat(64)}`,
      status: "Confirmed",
      kind: "mint",
      tokenId: "123456789",
    },
  ],
  checkouts: [],
};

test("marketplace payment needs a separate native-fee approval and preserves recovery details", async ({
  page,
}) => {
  const row = {
    id: "fixture-purchase",
    stage: "awaiting",
    status: "Awaiting payment",
    origin: "http://127.0.0.1:4322",
    nft: fixture.contract,
    tokenId: "1",
    recipient: fixture.address,
    price: "100000000000000",
    gasBudget: "100000000000000",
    zatoshis: "1000000",
    expiry: Math.floor(Date.now() / 1000) + 3600,
    confirmations: 0,
    requiredConfirmations: 10,
    ownerVerified: false,
    manualRecovery: false,
    refundDestination: "utest-SYNTHETIC-REFUND",
    recoveries: [],
  };
  let payments = 0;
  await page.route("**/api/purchases/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/pay")) payments++;
    const body = path.endsWith("/list")
      ? { purchases: [row] }
      : path.endsWith("/fee")
        ? {
            ...row,
            fee: {
              id: "fixture-fee",
              feeZatoshis: "20000",
              totalZatoshis: "1020000",
            },
          }
        : { ...row, stage: "sending" };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Purchases", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Awaiting payment", exact: true }),
  ).toBeVisible();
  expect(payments).toBe(0);
  await page.getByRole("button", { name: "Review Zcash fee" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("0.0102 TAZ");
  await expect(page.getByRole("dialog")).toContainText(
    "utest-SYNTHETIC-REFUND",
  );
  expect(payments).toBe(0);
  await page
    .getByRole("button", { name: "Approve & pay test ZEC", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(payments).toBe(1);
});
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown =
      path === "/api/session"
        ? { csrf: "fixture", connected: true }
        : path === "/api/dashboard"
          ? fixture
          : path === "/api/networks"
            ? { networks: [] }
            : path === "/api/dapps/list"
              ? {
                  connections: [
                    {
                      origin: "https://fixture.example",
                      created: 1791790421000,
                    },
                  ],
                  requests: [],
                }
              : path === "/api/action-draft"
                ? {
                    id: "draft",
                    digest: "digest",
                    description: "Fixed action only.",
                    intent: {
                      recipient: fixture.address,
                      contract: fixture.contract,
                      target: fixture.contract,
                      data: "0x1234",
                      value: "0",
                      maxValue: "0",
                      maxGasBudget: "5000000000000000",
                      zatoshis: "1000000",
                      expiry: Math.floor(Date.now() / 1000) + 3600,
                    },
                  }
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
test("malformed network data shows an error without crashing the wallet", async ({
  page,
}) => {
  await page.route("**/api/networks", (route) => route.fulfill({ json: {} }));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Wallet overview" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "EVM networks" }).getByRole("alert"),
  ).toContainText("Invalid response from the local service");
});

test("token swap requires exact intent approval and a separate native payment approval",async({page})=>{
 let quotes=0,approvals=0,payments=0;let stage="draft";
 const row={id:"synthetic-swap",recipient:fixture.address,token:fixture.contract,router:fixture.contract,route:[fixture.address,fixture.contract],amountIn:"100000000000000",expectedOut:"19000000000000000000",minOut:"18810000000000000000",slippageBps:100,referenceBlock:"1234",expiry:Math.floor(Date.now()/1000)+3600,zatoshis:"1000000",gasBudget:"100000000000000",impactBps:230,estimatedFee:"1000000000000",confirmations:0,trust:"Synthetic fixture. Simulated rate; manual recovery only.",fee:{id:"fee",feeZatoshis:"10000",totalZatoshis:"1010000"}};
 await page.route("**/api/swaps/**",async route=>{const path=new URL(route.request().url()).pathname;
  if(path.endsWith("/quote"))quotes++;
  if(path.endsWith("/approve")){approvals++;stage="awaiting";}
  if(path.endsWith("/pay")){payments++;stage="sent";}
  const view={...row,stage,status:stage==="draft"?"Awaiting quote approval":stage==="sent"?"Confirming":"Awaiting payment"};
  await route.fulfill({json:path.endsWith("/assets")?{available:true,tokens:[{address:fixture.contract,balance:"0"}]}:path.endsWith("/list")?{swaps:quotes?[view]:[]}:view});
 });
 await page.goto("/");await page.getByRole("button",{name:"Tokens",exact:true}).click();await expect(page.getByRole("heading",{name:"Your token purchases"})).toBeVisible();expect(approvals).toBe(0);expect(payments).toBe(0);
 await page.getByRole("button",{name:"Get AMM quote"}).click();await expect(page.getByRole("dialog")).toContainText("18.81 ZTEST");await expect(page.getByRole("dialog")).toContainText("100 bps");await expect(page.getByRole("dialog")).toContainText("230 bps");expect(payments).toBe(0);
 await page.getByRole("button",{name:"Approve exact swap intent",exact:true}).click();await expect(page.getByRole("dialog")).not.toBeVisible();expect(approvals).toBe(1);expect(payments).toBe(0);
 await page.getByRole("button",{name:"Review shielded payment"}).click();await expect(page.getByRole("dialog")).toContainText("0.0101 TAZ");expect(payments).toBe(0);
 await page.getByRole("button",{name:"Send shielded payment",exact:true}).click();await expect(page.getByRole("dialog")).not.toBeVisible();expect(payments).toBe(1);await expect(page.getByRole("heading",{name:"Confirming",exact:true})).toBeVisible();
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
test("sponsor screen displays fixed terms before its explicit approval", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(new URL(r.url()).pathname);
  });
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Sponsor", exact: true })
    .click();
  await page.getByRole("button", { name: "Review fixed action terms" }).click();
  await expect(
    page.getByText(/ZEC payment is a testnet service price/),
  ).toBeVisible();
  await expect(
    page.getByText(
      "0.005 ETH execution cap; Base L1 data fees may be additional",
    ),
  ).toBeVisible();
  expect(posts).toContain("/api/action-draft");
  expect(posts).not.toContain("/api/action-approve");
  await page.getByRole("button", { name: "Approve these exact terms" }).click();
  await expect.poll(() => posts.includes("/api/action-approve")).toBe(true);
});
test("apps page names exact origins and lets the user revoke a connection", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(new URL(r.url()).pathname);
  });
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Apps", exact: true })
    .click();
  await page.getByRole("button", { name: "Refresh list" }).click();
  await expect(
    page.getByText("https://fixture.example", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  expect(posts).toContain("/api/dapps/revoke");
});
