// Presentation-only fixtures. Not a real payment or destination transaction.
import { test, expect } from "@playwright/test";
test("wallet separates review, signed order consent, private payment reveal and confirmation", async ({
  page,
}) => {
  const recipient = "0x2222222222222222222222222222222222222222";
  let authorized = false,
    confirmed = false,
    completed = false,
    reviews = 0,
    reveals = 0;
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    let json: any = {
      networks: [],
      checkouts: [],
      accounts: [],
      orders: [],
      permissions: [],
    };
    if (path === "/api/session") json = { connected: true, csrf: "fixture" };
    if (path === "/api/dashboard")
      json = {
        address: "0x1111111111111111111111111111111111111111",
        contract: "",
        priceZatoshis: "0",
        zcash: null,
        base: null,
        nfts: [],
        checkouts: [],
        baseActivity: [],
        health: {
          zcash: "Not opened",
          base: "Not opened",
          worker: "Disabled",
          busy: false,
        },
        readOnlyNotice: "No signing keys loaded.",
      };
    if (path === "/api/native-transfer/config")
      json = {
        chainId: 11155111,
        recipients: [recipient],
        authorizer: "0x1111111111111111111111111111111111111111",
        financialCreationEnabled: true,
      };
    if (path === "/api/native-transfer/review") {
      reviews++;
      expect(route.request().postDataJSON()).toEqual({
        recipient,
        amount: "1000000000000",
      });
      json = {
        id: "fixture-review",
        recipient,
        amount: "1000000000000",
        feeCapWei: "100000000000000",
        expires: 2000000000,
        message: "ZecOne TESTNET exact fixture order consent",
        financialOrderCreated: false,
      };
    }
    if (path === "/api/native-transfer/authorize") {
      authorized = true;
      json = { state: "PAYMENT_PENDING", financialOrderCreated: true };
    }
    if (path === "/api/native-transfer/payment-request") {
      reveals++;
      expect(authorized).toBe(true);
      json = {
        address: "utest1_SYNTHETIC_PRIVATE_RECEIVER",
        zatoshis: "100000",
        expiry: 2000000000,
      };
    }
    if (path === "/api/native-transfer/status")
      json = {
        state: completed
          ? "COMPLETED"
          : confirmed
            ? "PAYMENT_CONFIRMED"
            : "PAYMENT_PENDING",
        transactionHash: completed ? `0x${"a".repeat(64)}` : null,
        receivedZatoshis: confirmed ? "100000" : "0",
        confirmedZatoshis: confirmed ? "100000" : "0",
        requiredConfirmations: 10,
        financialOrderCreated: authorized,
      };
    if (path.startsWith("/api/native-transfer")) expect(url.search).toBe("");
    return route.fulfill({ json });
  });
  await page.goto("/?view=Send%20%2F%20Receive");
  const panel = page.getByRole("region", {
    name: "ZEC-funded native transfer",
  });
  await expect(panel).toBeVisible();
  await panel
    .getByRole("button", { name: "Review native delivery", exact: true })
    .click();
  expect(authorized).toBe(false);
  expect(reveals).toBe(0);
  await panel
    .getByRole("textbox", { name: /Public signature/ })
    .fill(`0x${"1".repeat(130)}`);
  await panel
    .getByRole("button", { name: "Authorize this payment request" })
    .click();
  await expect(panel.getByRole("status")).toContainText("PAYMENT_PENDING");
  await panel
    .getByRole("button", { name: "Reveal shielded testnet payment request" })
    .click();
  await expect(
    panel.getByText("utest1_SYNTHETIC_PRIVATE_RECEIVER", { exact: true }),
  ).toBeVisible();
  confirmed = true;
  await expect(panel.getByRole("status")).toContainText("PAYMENT_CONFIRMED", {
    timeout: 10000,
  });
  await expect(
    panel.getByText("utest1_SYNTHETIC_PRIVATE_RECEIVER", { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", {
      name: /^(sign transaction|broadcast|execute)/i,
    }),
  ).toHaveCount(0);
  expect(reviews).toBe(1);
  expect(reveals).toBe(1);
  completed = true;
  await expect(panel.getByRole("status")).toContainText("COMPLETED", {
    timeout: 10000,
  });
  await expect(
    panel.getByText(`0x${"a".repeat(64)}`, { exact: true }),
  ).toBeVisible();
});
