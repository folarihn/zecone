// Synthetic UI data only; never evidence of a live swap.
import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
const recipient = "11111111111111111111111111111111";
test("swap checkout explains public ownership, binds fresh recipient and hides cross-chain records", async ({
  page,
}) => {
  let quoted = false;
  await page.route("**/api/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    const row = {
      handle: "scoped-synthetic-handle",
      network: "solana:devnet",
      state: "AWAITING_SOLANA_AUTHORIZATION",
      recipient,
      zatoshis: "100000",
      expires: 2000000000,
      confirmations: 10,
      requiredConfirmations: 10,
      estimatedFee: "5000",
      swap: {
        outputMint: "2j76mnkJEBxbYv8T9c76PbsGzf5XuhpRoK1kwwTg9MpY",
        expectedOut: "1000000",
        minimumOut: "990000",
      },
    };
    return r.fulfill({
      json:
        path === "/api/session"
          ? { csrf: "fixture", connected: true }
          : path === "/api/dashboard"
            ? {
                address: "0x1111111111111111111111111111111111111111",
                contract: "",
                priceZatoshis: "0",
                zcash: null,
                base: null,
                nfts: [],
                baseActivity: [],
                checkouts: [],
                health: {
                  zcash: "Fixture",
                  base: "Fixture",
                  worker: "Fixture",
                  busy: false,
                },
              }
            : path === "/api/solana-swap/config"
              ? { freshRecipient: recipient, existingRecipients: [] }
              : path === "/api/solana-swap/quote"
                ? ((quoted = true), row)
                : path === "/api/solana-swap/status"
                  ? { orders: quoted ? [row] : [] }
                  : path === "/api/solana/accounts"
                    ? { accounts: [] }
                    : path === "/api/solana/permissions"
                      ? { permissions: [] }
                      : { networks: [], checkouts: [] },
    });
  });
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.goto("/?view=Solana");
  await expect(
    page.getByRole("heading", {
      name: "Shielded ZEC-funded Solana token swap",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review bounded token swap" }).click();
  await expect(
    page.getByText("Minimum received: 990000 base units.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Solana swap transactions and token ownership remain public/,
    ),
  ).toBeVisible();
  await expect(page.getByText(/Zcash confirmations: 10 \/ 10/)).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /broadcast|sign transaction|execute swap/i,
    }),
  ).toHaveCount(0);
  const text = await page.locator("body").innerText();
  for (const denied of [
    "fullViewingKey",
    "paymentTxs",
    "profileId",
    "requestId",
  ])
    expect(text).not.toContain(denied);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
