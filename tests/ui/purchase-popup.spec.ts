// Synthetic popup integration only; every API is intercepted and no key is loaded.
import { test, expect } from "@playwright/test";
test("marketplace popup shows exact quote approval then the separate payment panel", async ({
  page,
  context,
}) => {
  const id = "11111111-1111-4111-8111-111111111111",
    channel = "22222222-2222-4222-8222-222222222222",
    account = "0x1111111111111111111111111111111111111111";
  let approvals = 0,
    payments = 0;
  const row = {
    id,
    chainId: 46630,
    networkName: "Robinhood Chain Testnet",
    stage: "awaiting",
    status: "Awaiting payment",
    origin: "http://127.0.0.1:3211",
    nft: account,
    tokenId: "1",
    recipient: account,
    price: "100000000000000",
    zatoshis: "1500000",
    gasBudget: "200000000000000",
    expiry: Math.floor(Date.now() / 1000) + 3600,
    confirmations: 0,
    requiredConfirmations: 10,
    manualRecovery: false,
  };
  const review = {
    done: false,
    id,
    origin: row.origin,
    method: "zecone_payWithZec",
    state: "pending",
    reviewHash: "synthetic",
    review: { ...row, account, seller: account, trust: "Synthetic test quote" },
  };
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: any = {};
    if (path === "/api/session") body = { connected: true, csrf: "synthetic" };
    if (path === "/api/dapps/list")
      body = { connections: [{ origin: row.origin }] };
    if (path === "/api/dapps/request" || path === "/api/dapps/status")
      body = review;
    if (path === "/api/dapps/approve") {
      approvals++;
      body = { done: true, result: { purchaseId: id } };
    }
    if (path === "/api/purchases/list") body = { purchases: [row] };
    if (path === "/api/purchases/pay") payments++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto("/");
  const popupPromise = context.waitForEvent("page");
  await page.evaluate((channel) => {
    (window as any).testPopup = window.open(
      `/connect#${channel}`,
      "_blank",
      "popup,width=580,height=820",
    );
  }, channel);
  const popup = await popupPromise;
  await expect(
    popup.getByText("Ready. Return to the application to request an action."),
  ).toBeVisible();
  await page.evaluate(
    ({ id, channel }) =>
      (window as any).testPopup.postMessage(
        {
          protocol: "zecone:2",
          kind: "request",
          channel,
          id,
          method: "zecone_payWithZec",
          params: [{}],
        },
        location.origin,
      ),
    { id, channel },
  );
  await expect(
    popup.getByRole("heading", { name: "Review marketplace quote" }),
  ).toBeVisible();
  await expect(popup.locator(".origin-box")).toContainText(row.origin);
  await expect(popup.getByText("Robinhood Chain Testnet · chain 46630", {exact:true})).toBeVisible();
  await expect(
    popup.getByRole("button", { name: "Approve purchase quote", exact: true }),
  ).toBeVisible();
  expect(payments).toBe(0);
  await popup
    .getByRole("button", { name: "Approve purchase quote", exact: true })
    .click();
  await expect(
    popup.getByRole("button", { name: "Review Zcash fee" }),
  ).toBeVisible();
  expect(approvals).toBe(1);
  expect(payments).toBe(0);
  expect(
    await popup.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});
