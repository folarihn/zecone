// Synthetic API fixtures, never real balances or live settlement evidence.
import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
const evidence = process.env.ZECONE_QA_EVIDENCE_DIR ?? "docs/phase6-evidence";
const address = "0x1111111111111111111111111111111111111111";
const dashboard = {
  address,
  contract: address,
  priceZatoshis: "100000",
  zcash: {
    totalZatoshis: "200000",
    spendableZatoshis: "100000",
    tip: 1,
    scanned: 1,
    observedAt: 1,
    history: [],
  },
  base: null,
  nfts: [],
  baseActivity: [],
  checkouts: [],
  health: {
    zcash: "Synthetic fixture",
    base: "unavailable",
    worker: "Fixture only",
    busy: false,
  },
};
const record = {
  key: "swap:fixture",
  id: "fixture",
  kind: "swap",
  state: "RECOVERY_REQUIRED",
  status: "Manual recovery required",
  stage: "review",
  chainId: 84532,
  networkName: "Base Sepolia",
  recipient: address,
  zatoshis: "100000",
  expiry: 1,
  confirmations: 12,
  requiredConfirmations: 10,
  paymentTx: "a".repeat(64),
  paymentAddress: "utest-SYNTHETIC",
  destinationTx: null,
  resultVerified: false,
  recovery: "Payment construction interrupted. Reconcile saved transaction.",
  liveRefundsEnabled: false,
  fee: { feeZatoshis: "10000" },
};
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    const body =
      p === "/api/session"
        ? { csrf: "synthetic", connected: true }
        : p === "/api/dashboard"
          ? dashboard
          : p === "/api/checkouts"
            ? { checkouts: [record] }
            : p === "/api/networks"
              ? { networks: [] }
              : p === "/api/swaps/assets"
                ? { available: false }
                : p === "/api/swaps/list"
                  ? { swaps: [] }
                  : p === "/api/purchases/list" || p === "/api/seaport/list"
                    ? { purchases: [] }
                    : p === "/api/dapps/list"
                      ? { connections: [], requests: [] }
                      : { listings: [] };
    await route.fulfill({ json: body });
  });
});
test("eight primary destinations have real views and URL refresh recovery", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("button")).toHaveCount(8);
  for (const name of [
    "Overview",
    "Wallet",
    "Send / Receive",
    "Swap",
    "NFTs",
    "Activity",
    "Connected Apps",
    "Settings",
  ]) {
    await nav.getByRole("button", { name, exact: true }).click();
    await expect(page.locator("h1")).toBeVisible();
  }
  await expect(
    page.getByRole("heading", { name: "Account and security" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Account and security" }),
  ).toBeVisible();
});
test("checkout recovery survives refresh without payment calls or fabricated refunds", async ({
  page,
}) => {
  let writes = 0;
  page.on("request", (r) => {
    if (r.method() === "POST") writes++;
  });
  await page.goto("/");
  const tracker = page.getByRole("region", {
    name: "Unified checkout tracker",
  });
  await expect(tracker).toContainText("Recovery required");
  await expect(tracker).toContainText("12 / 10");
  await expect(tracker).toContainText("Live refunds disabled");
  await page.getByLabel("Saved checkout").selectOption(record.key);
  await page.reload();
  await expect(page.getByLabel("Saved checkout")).toHaveValue(record.key);
  expect(writes).toBe(0);
  await page.screenshot({
    path: `${evidence}/ui-checkout-fixture.png`,
    fullPage: true,
  });
});
test("dashboard uses supplied balances and unknown EVM balance remains unavailable", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Wallet balances")).toContainText("0.002");
  await expect(page.getByLabel("Wallet balances")).toContainText(
    "0.001 TAZ available",
  );
  await expect(page.getByLabel("Wallet balances")).toContainText(
    "0.001 TAZ unavailable / pending",
  );
  await expect(page.getByLabel("Wallet balances")).not.toContainText("$");
  await page.screenshot({
    path: `${evidence}/ui-overview-fixture.png`,
    fullPage: true,
  });
  await page.screenshot({
    path: `${evidence}/ui-overview-viewport-fixture.png`,
    fullPage: false,
  });
});
test("receive network selection is independent of website approvals and unsupported Zcash sends are disabled", async ({
  page,
}) => {
  await page.goto("/?view=Send%20%2F%20Receive");
  await page.getByLabel("Receive network").selectOption("46630");
  await expect(page.getByLabel("Receive network")).toHaveValue("46630");
  await expect(
    page.getByRole("button", {
      name: "General-purpose Zcash send unavailable",
    }),
  ).toBeDisabled();
  await expect(page.getByLabel("Send and receive")).toContainText(address);
});
test("failed checkout reads show an actionable error with no fabricated empty success", async ({
  page,
}) => {
  await page.route("**/api/checkouts", (r) =>
    r.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.goto("/");
  await expect(
    page.getByLabel("Unified checkout tracker").getByRole("alert"),
  ).toContainText("No payment was retried");
  await expect(page.getByText("No saved checkouts")).toHaveCount(0);
});
test("mobile layout and keyboard focus remain accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByLabel("Unified checkout tracker")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const scan = await new AxeBuilder({ page }).analyze();
  expect(
    scan.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: `${evidence}/ui-mobile-fixture.png`,
    fullPage: true,
  });
});
test("unavailable swap adapters show no executable fake quote", async ({
  page,
}) => {
  await page.goto("/?view=Tokens");
  await expect(
    page.getByRole("heading", { name: "Your token purchases" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Get AMM quote" })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: `${evidence}/ui-swap-fixture.png`,
    fullPage: true,
  });
});
test("expired swap reviews cannot authorize payment or an execution intent", async ({
  page,
}) => {
  const q = {
    id: "expired",
    recipient: address,
    token: address,
    router: address,
    route: [address, address],
    amountIn: "1",
    expectedOut: "2",
    minOut: "1",
    slippageBps: "100",
    expiry: 1,
    referenceBlock: "1",
    zatoshis: "100000",
    estimatedFee: "1",
    gasBudget: "1",
    impactBps: 0,
  };
  let approvals = 0;
  await page.route("**/api/swaps/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p.endsWith("/approve") || p.endsWith("/pay")) approvals++;
    await r.fulfill({
      json: p.endsWith("/assets")
        ? { available: true, tokens: [{ address, balance: "0" }] }
        : p.endsWith("/list")
          ? { swaps: [] }
          : q,
    });
  });
  await page.goto("/?view=Tokens");
  await page.getByRole("button", { name: "Get AMM quote" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Approve exact swap intent",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Quote expired",
  );
  expect(approvals).toBe(0);
});
