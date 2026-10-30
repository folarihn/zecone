// Synthetic browser-only fixtures. Never use real protected evidence in captures.
import { test, expect } from "@playwright/test";
const opaque = "11111111-1111-4111-8111-111111111111",
  key = `mint:${opaque}`;
const scope = "fixture-session",
  expires = Date.now() + 3600000;
const checkout = {
  key,
  id: opaque,
  kind: "mint",
  state: "COMPLETED",
  status: "Completed",
  stage: "sent",
  chainId: 84532,
  networkName: "Base Sepolia",
  recipient: "0x1111111111111111111111111111111111111111",
  zatoshis: "100000",
  expiry: 2000000000,
  confirmations: 10,
  requiredConfirmations: 10,
  paymentTx: null,
  paymentAddress: null,
  destinationTx: null,
  resultVerified: true,
};
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data =
      path === "/api/dashboard"
        ? {
            address: checkout.recipient,
            contract: "",
            priceZatoshis: "0",
            zcash: null,
            base: null,
            nfts: [],
            baseActivity: [],
            checkouts: [],
            health: { zcash: "", base: "", worker: "", busy: false },
          }
        : path === "/api/session"
          ? { csrf: "fixture", connected: true }
          : path === "/api/checkouts"
            ? {
                checkouts: [checkout],
                selectionScope: scope,
                selectionExpires: expires,
              }
            : path === "/api/checkouts/inspect"
              ? {
                  paymentTx: "PRIVATE_FIXTURE_REFERENCE",
                  privacy: "Local only",
                }
              : {
                  networks: [],
                  purchases: [],
                  swaps: [],
                  listings: [],
                  connections: [],
                  requests: [],
                  orders: [],
                };
    await route.fulfill({ json: data });
  });
});
test("Phase 8A clears old persistent selection and stores only scoped expiring handles", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("zecone.checkout.selection", "PRIVATE_OLD_IDENTIFIER"),
  );
  await page.goto("/");
  const select = page
    .getByLabel("Unified checkout tracker")
    .getByLabel("Saved checkout");
  await expect(select).toBeVisible();
  await select.selectOption(key);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("zecone.checkout.selection"),
    ),
  ).toBeNull();
  const stored = await page.evaluate(() =>
    sessionStorage.getItem("zecone.checkout.session-selection"),
  );
  expect(JSON.parse(stored!)).toEqual({ scope, expires, key });
  await page.reload();
  await expect(select).toHaveValue(key);
});
test("Phase 8A private reference appears only after explicit inspection and clears on refresh", async ({
  page,
}) => {
  await page.clock.install();
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/checkouts/inspect")) requests++;
  });
  await page.goto("/");
  const tracker = page.getByLabel("Unified checkout tracker");
  await expect(tracker.getByText("PRIVATE_FIXTURE_REFERENCE")).toHaveCount(0);
  await tracker
    .getByRole("button", { name: "Inspect private payment reference locally" })
    .click();
  await expect(tracker.getByText("PRIVATE_FIXTURE_REFERENCE")).toBeVisible();
  expect(requests).toBe(1);
  await page.clock.fastForward(61000);
  await expect(tracker.getByText("PRIVATE_FIXTURE_REFERENCE")).toHaveCount(0);
  await page.reload();
  await expect(tracker.getByText("PRIVATE_FIXTURE_REFERENCE")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("PRIVATE_FIXTURE_REFERENCE");
});
test("Phase 8A session denial clears checkout data and browser selection", async ({
  page,
}) => {
  await page.goto("/");
  const tracker = page.getByLabel("Unified checkout tracker");
  await tracker.getByLabel("Saved checkout").selectOption(key);
  await page.route("**/api/checkouts", (route) =>
    route.fulfill({ status: 401, json: { error: "Session expired" } }),
  );
  await expect(tracker.getByRole("alert")).toBeVisible({ timeout: 10000 });
  await expect(tracker.getByLabel("Saved checkout")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("zecone.checkout.session-selection"),
    ),
  ).toBeNull();
});
test("Phase 8A known session deadline clears private data even before another server response", async ({
  page,
}) => {
  await page.clock.install();
  const deadline = Date.now() + 3000;
  await page.route("**/api/checkouts", (r) =>
    r.fulfill({
      json: {
        checkouts: [checkout],
        selectionScope: scope,
        selectionExpires: deadline,
      },
    }),
  );
  await page.goto("/");
  const tracker = page.getByLabel("Unified checkout tracker");
  await tracker.getByLabel("Saved checkout").selectOption(key);
  await tracker
    .getByRole("button", { name: "Inspect private payment reference locally" })
    .click();
  await expect(tracker.getByText("PRIVATE_FIXTURE_REFERENCE")).toBeVisible();
  // A late/cached successful list must not restore an already-expired view.
  await page.clock.fastForward(7000);
  await expect(tracker.getByLabel("Saved checkout")).toHaveCount(0);
  await expect(tracker.getByText("PRIVATE_FIXTURE_REFERENCE")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("zecone.checkout.session-selection"),
    ),
  ).toBeNull();
});
