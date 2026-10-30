// Synthetic checkout UI; no real payment or broadcast.
import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
const row = {
  id: "0x" + "a".repeat(64),
  state: "AWAITING_SOLANA_AUTHORIZATION",
  recipient: "11111111111111111111111111111111",
  lamports: "1000000",
  zatoshis: "100000",
  feeCap: "10000",
  expires: 2000000000,
  confirmedZatoshis: "100000",
  signature: null,
  prepared: { digest: "b".repeat(64), fee: "5000" },
};
test("ZEC-funded Solana checkout shows exact demo terms and awaiting approval without completion", async ({
  page,
}) => {
  await page.route("**/api/**", (r) => {
    const p = new URL(r.request().url()).pathname;
    return r.fulfill({
      json:
        p === "/api/session"
          ? { csrf: "synthetic", connected: true }
          : p === "/api/dashboard"
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
            : p === "/api/solana-settlement/status"
              ? { orders: [row] }
              : p === "/api/solana/accounts"
                ? { accounts: [] }
                : p === "/api/solana/permissions"
                  ? { permissions: [] }
                  : { networks: [], checkouts: [] },
    });
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/?view=Solana");
  await expect(
    page.getByRole("heading", {
      name: "AWAITING SOLANA AUTHORIZATION",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Delivery: 0.001 devnet SOL", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Simulation is not completion/)).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /broadcast|send payment|sign transaction/i,
    }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
});
