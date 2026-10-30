// Presentation fixtures only, no live account, payment or signing service.
import { test, expect } from "@playwright/test";
test("wallet economic review exposes bounded terms and no payment authorization", async ({
  page,
}) => {
  let reviews = 0;
  const recipient = "11111111111111111111111111111111";
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {
      networks: [],
      checkouts: [],
      accounts: [],
      orders: [],
      permissions: [],
    };
    if (path === "/api/session") json = { csrf: "fixture", connected: true };
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
        readOnlyNotice:
          "Economic review only. No wallet ownership proof or spending.",
      };
    if (path === "/api/settlement-review/config")
      json = { recipients: [recipient], financialCreationEnabled: false };
    if (path === "/api/settlement-review") {
      reviews++;
      expect(route.request().postDataJSON()).toEqual({
        action: "transfer",
        recipient,
        lamports: "1000000",
      });
      json = {
        recipient,
        expires: 2000000000,
        financialOrderCreated: false,
        executionAuthorized: false,
      };
    }
    return route.fulfill({ json });
  });
  await page.goto("/?view=Solana");
  const panel = page.getByRole("region", {
    name: "Settlement economic review",
  });
  await expect(panel).toBeVisible();
  await panel
    .getByRole("button", { name: "Review economic terms only" })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "No financial order, payment request, signed transaction or broadcast",
  );
  expect(reviews).toBe(1);
  await expect(
    panel.getByRole("button", {
      name: /pay|sign|execute|broadcast|authorize/i,
    }),
  ).toHaveCount(0);
});
