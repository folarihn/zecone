// Opt-in real shielded Zcash payment for the single fixed Base Sepolia action.
// The one-run marker is set before the send approval; never delete it to retry.
import { chromium, expect } from "@playwright/test";
import { existsSync, writeFileSync } from "node:fs";
import { exclusiveJson, readJson } from "../services/execution/io.ts";
const marker = ".state/phase2-sponsor-live-started.json",
  evidence = "docs/phase2-evidence";
if (!process.argv.includes("--allow-testnet-spend"))
  throw Error("Explicit testnet Zcash payment approval flag required.");
const prior = existsSync(marker) ? readJson<any>(marker) : null;
if (
  prior?.paymentApprovalStarted ||
  prior?.paymentRequested ||
  prior?.paymentTx
)
  throw Error(
    "Sponsor send approval was already reached. Inspect the existing payment and action before recovery.",
  );
const state = prior ?? {
  startedAt: new Date().toISOString(),
  paymentApprovalStarted: false,
  scope:
    "One user-approved 0.01 TAZ shielded payment for the fixed recordFor action.",
};
if (!prior) exclusiveJson(marker, state);
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({
      storageState: ".secrets/phase2-browser-session.json",
      viewport: { width: 1440, height: 1050 },
    }),
    page = await context.newPage();
  await page.goto("http://127.0.0.1:3210/");
  await expect(
    page.getByRole("heading", { name: "Wallet overview" }),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Sponsor", exact: true })
    .click();
  let dashboard = await page.evaluate(
    async () =>
      await (await fetch("/api/dashboard", { cache: "no-store" })).json(),
  );
  let order = dashboard.checkouts.find(
    (c: any) => c.kind === "action" && c.status === "Awaiting payment",
  );
  let terms = String(state.intentTerms ?? "");
  if (!order) {
    await page
      .getByRole("button", { name: "Review fixed action terms" })
      .click();
    await expect(
      page.getByText(
        "0.005 ETH execution cap; Base L1 data fees may be additional",
      ),
    ).toBeVisible();
    terms = await page.locator(".checkout-panel").innerText();
    await page.screenshot({
      path: `${evidence}/action-intent-review.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Approve these exact terms" })
      .click();
    await expect(
      page.getByRole("button", { name: "Review shielded payment and fee" }),
    ).toBeVisible({ timeout: 120000 });
    dashboard = await page.evaluate(
      async () =>
        await (await fetch("/api/dashboard", { cache: "no-store" })).json(),
    );
    order = dashboard.checkouts.find(
      (c: any) => c.kind === "action" && c.status === "Awaiting payment",
    );
  }
  if (!order) throw Error("No saved action order is awaiting payment.");
  state.checkoutId = order.id;
  state.intentTerms = terms;
  writeFileSync(marker, JSON.stringify(state, null, 2), {
    flag: "w",
    mode: 0o600,
  });
  const reviewButton = page.getByRole("button", {
    name: order.quote
      ? "Open payment review"
      : "Review shielded payment and fee",
  });
  await expect(reviewButton).toBeVisible({ timeout: 30000 });
  await reviewButton.click();
  await expect(
    page.getByRole("heading", { name: "Approve ZEC-funded action payment" }),
  ).toBeVisible({ timeout: 120000 });
  const paymentReview = await page.getByRole("dialog").innerText();
  if (
    !paymentReview.includes("Maximum network fee") ||
    !paymentReview.includes("shielded")
  )
    throw Error("Payment review did not show amount and network fee.");
  await page.screenshot({
    path: `${evidence}/action-payment-review.png`,
    fullPage: true,
  });
  state.paymentReview = paymentReview;
  state.paymentApprovalStarted = true;
  writeFileSync(marker, JSON.stringify(state, null, 2), {
    flag: "w",
    mode: 0o600,
  });
  await page.getByRole("button", { name: "Approve & send test ZEC" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 60000 });
  const latest = await page.evaluate(
    async () =>
      await (await fetch("/api/dashboard", { cache: "no-store" })).json(),
  );
  const saved = latest.checkouts.find((c: any) => c.id === order.id);
  if (!saved)
    throw Error("Approved action checkout not found after payment request.");
  const result = {
    approvedAt: new Date().toISOString(),
    checkoutId: order.id,
    kind: "fixed test action",
    status: saved.status,
    stage: saved.stage,
    paymentTx: saved.paymentTx ?? null,
    confirmations: saved.confirmations,
    requiredConfirmations: saved.requiredConfirmations,
    privacy:
      "Payment remains shielded; the local settlement operator can correlate it to the public Base action.",
  };
  state.paymentRequested = true;
  state.paymentTx = result.paymentTx;
  writeFileSync(marker, JSON.stringify(state, null, 2), {
    flag: "w",
    mode: 0o600,
  });
  writeFileSync(
    `${evidence}/sponsor-start.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (e) {
  writeFileSync(
    ".state/phase2-sponsor-error.log",
    e instanceof Error ? (e.stack ?? e.message) : "Unknown error",
  );
  console.error(
    "Sponsor flow stopped. Preserve its marker and saved order; inspect the real checkout before recovery.",
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
