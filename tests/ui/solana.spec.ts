// Synthetic UI fixtures. Actual RPC simulation lives in phase7a-evidence/devnet.json.
import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
const owner = "11111111111111111111111111111111",
  recipient = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    const data: Record<string, unknown> = {
      "/api/session": { csrf: "fixture", connected: true },
      "/api/dashboard": {
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
      },
      "/api/solana/accounts": {
        accounts: [
          { label: "payer", address: owner },
          { label: "recipient", address: recipient },
        ],
      },
      "/api/solana/permissions": { permissions: [] },
      "/api/solana/balance": {
        sol: "0.100000000",
        observedAt: "Synthetic fixture",
        tokens: [],
      },
      "/api/solana/prepare": {
        id: "synthetic-preview",
        state: "AWAITING_EXPLICIT_APPROVAL",
        action: { recipient },
        fee: "5000",
        simulation: { err: null, unitsConsumed: "150" },
        lifetime: { lastValidBlockHeight: "100" },
      },
    };
    await r.fulfill({
      json: data[p] ?? {
        networks: [],
        checkouts: [],
        connections: [],
        requests: [],
      },
    });
  });
});
for (const width of [1440, 390])
  test(`Solana panel at ${width}px has truthful balances, simulation and accessible controls`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?view=Solana");
    await page.getByRole("button", { name: "Refresh devnet balance" }).click();
    await expect(
      page.getByRole("heading", { name: "0.100000000 SOL (devnet)" }),
    ).toBeVisible();
    await expect(
      page.getByText("No SPL or Token-2022 accounts found."),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Prepare and simulate", exact: true })
      .click();
    await expect(
      page.getByText("AWAITING_EXPLICIT_APPROVAL", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/This is not a confirmed transaction/),
    ).toBeVisible();
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
test("Solana account switching clears stale balance and RPC failure never displays zero", async ({
  page,
}) => {
  await page.goto("/?view=Solana");
  await page.getByRole("button", { name: "Refresh devnet balance" }).click();
  await page.getByLabel("Account", { exact: true }).selectOption(recipient);
  await expect(page.getByText("0.100000000 SOL (devnet)")).toHaveCount(0);
  await page.route("**/api/solana/balance", (r) =>
    r.fulfill({ status: 503, json: { error: "RPC unavailable" } }),
  );
  await page.getByRole("button", { name: "Refresh devnet balance" }).click();
  await expect(
    page.getByText("RPC unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("0.000000000 SOL (devnet)")).toHaveCount(0);
});
