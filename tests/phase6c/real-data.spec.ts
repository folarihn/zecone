// Local product QA using copied real historical data. No API route mocks.
import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { readFileSync, writeFileSync } from "node:fs";
const evidence = process.env.ZECONE_QA_EVIDENCE_DIR ?? "docs/phase6c-evidence";
let cookie: any;
const snapshot = JSON.parse(
  readFileSync(".state/phase6c/snapshot.json", "utf8"),
);
test.beforeAll(async ({ request, browser }) => {
  const token = JSON.parse(
    readFileSync(".state/phase6c/pairing.json", "utf8"),
  ).token;
  const response = await request.post("/api/pair", {
    headers: { Origin: "http://127.0.0.1:3210" },
    data: { token },
  });
  expect(response.status()).toBe(200);
  cookie = (await request.storageState()).cookies.find(
    (c) => c.name === "zecone_session",
  );
  writeFileSync(
    `${evidence}/local-browser.json`,
    JSON.stringify(
      {
        browser: browser.version(),
        extension: "not loaded in this local UI run",
        snapshot: snapshot.capturedAt,
        apiMocking: false,
        broadcast: false,
      },
      null,
      2,
    ),
  );
});
test.beforeEach(async ({ context }) => {
  await context.addCookies([cookie]);
});
for (const [name, width, height] of [
  ["desktop", 1440, 1000],
  ["narrow", 900, 1000],
  ["mobile", 390, 844],
] as const) {
  test(`real historical wallet ${name}: truthful snapshot labels, layout and accessibility`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.getByText(/Historical snapshot captured/)).toBeVisible();
    await expect(page.getByText(/Historical total 0.018975 TAZ/)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Refund awaiting authorization" }),
    ).toBeVisible();
    await expect(
      page.getByText(/Unsigned draft: 0.0009 TAZ refund/),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: `${evidence}/real-${name}.png`,
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByText(/Historical snapshot captured/)).toBeVisible();
    expect((await page.request.get("/api/session")).status()).toBe(200);
  });
}
test("historical checkout adapters replay real references and survive refresh without payment requests", async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") mutations.push(r.url());
  });
  await page.goto("/?view=Overview");
  const tracker = page.getByRole("region", {
    name: "Unified checkout tracker",
  });
  const selection = tracker.getByLabel("Saved checkout");
  await expect(selection.locator("option")).toHaveCount(
    snapshot.checkouts.length,
  );
  for (const kind of ["mint", "purchase", "swap", "seaport"]) {
    const row = snapshot.checkouts.find(
      (c: any) => c.kind === kind && c.state === "COMPLETED",
    );
    expect(row).toBeTruthy();
    await selection.selectOption(row.key);
    await tracker.getByText("Transaction details, fees and references").click();
    await expect(
      tracker.getByText(row.destinationTx, { exact: true }),
    ).toBeVisible();
    await expect(
      tracker.getByText(row.paymentTx, { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(selection).toHaveValue(row.key);
  }
  await page.screenshot({
    path: `${evidence}/real-checkout.png`,
    fullPage: true,
  });
  expect(mutations).toEqual([]);
});
test("read-only UI handles denied refresh without starting a worker", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText(/Historical snapshot captured/)).toBeVisible();
  const session = await (await page.request.get("/api/session")).json();
  for (const path of ["refresh", "pay", "dapps/approve", "refund/sign"]) {
    const response = await page.request.post(`/api/${path}`, {
      headers: {
        Origin: "http://127.0.0.1:3210",
        "x-zecone-csrf": session.csrf,
      },
      data: { approved: true },
    });
    expect(response.status()).toBe(403);
    expect((await response.json()).error).toMatch(/read-only/);
  }
});
test("network loss reports stale checkout data and reconnect restores the saved selection", async ({
  page,
  context,
}) => {
  await page.goto("/?view=Overview");
  const tracker = page.getByRole("region", {
    name: "Unified checkout tracker",
  });
  await expect(tracker.getByLabel("Saved checkout")).toBeVisible();
  await context.setOffline(true);
  await expect(tracker.getByRole("alert")).toBeVisible({ timeout: 10000 });
  await context.setOffline(false);
  await page.reload();
  await expect(tracker.getByLabel("Saved checkout")).toBeVisible();
  await expect(tracker.getByRole("alert")).toHaveCount(0);
});
