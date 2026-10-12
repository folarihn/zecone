// Resume only the already-signed marketplace quote. Never makes a replacement quote.
import { chromium, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { readJson } from "../services/execution/io.ts";
if (!process.argv.includes("--allow-testnet-spend"))
  throw Error("Explicit testnet payment flag required");
const path = ".state/phase3-live-started.json",
  state = readJson<any>(path);
if (state.paymentApprovalStarted || state.paymentRequested)
  throw Error("Payment approval already started. Reconcile only.");
const db = new DatabaseSync(".state/purchases.sqlite", { readOnly: true });
const rows = db
  .prepare(
    "SELECT id,stage,order_id,payment_tx,intent FROM purchase_requests WHERE stage IN ('review','awaiting','quoted') ORDER BY created DESC",
  )
  .all() as any[];
db.close();
if (
  rows.length !== 1 ||
  rows[0].payment_tx ||
  JSON.parse(rows[0].intent).listingId !== "1"
)
  throw Error("Ambiguous saved quote");
state.purchaseId = rows[0].id;
const save = () =>
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
save();
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({
      storageState: ".secrets/phase3-browser-session.json",
      viewport: { width: 1440, height: 1050 },
    }),
    page = await context.newPage();
  await page.goto("http://127.0.0.1:3210/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Purchases", exact: true })
    .click();
  const article = page
    .locator("article")
    .filter({
      has: page.getByRole("heading", {
        name:
          rows[0].stage === "review"
            ? "Manual recovery required"
            : "Awaiting payment",
        exact: true,
      }),
    })
    .first();
  if (rows[0].stage === "review") {
    await article
      .getByRole("button", { name: "Recheck saved purchase" })
      .click();
    await expect(
      page.getByRole("button", { name: "Review Zcash fee" }),
    ).toBeVisible({ timeout: 120000 });
  }
  await page.getByRole("button", { name: "Review Zcash fee" }).click();
  await expect(
    page.getByRole("heading", { name: "Authorize shielded payment" }),
  ).toBeVisible({ timeout: 120000 });
  const text = await page.getByRole("dialog").innerText();
  if (!text.includes("0.01 TAZ") || !text.includes("Maximum Zcash fee"))
    throw Error("Unexpected payment review");
  await page.screenshot({
    path: "docs/phase3-evidence/payment-approval.png",
    fullPage: true,
  });
  state.paymentReview = text;
  state.paymentApprovalStarted = true;
  save();
  await page
    .getByRole("button", { name: "Approve & pay test ZEC", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 90000 });
  state.paymentRequested = true;
  save();
  writeFileSync(
    "docs/phase3-evidence/browser-start.json",
    JSON.stringify(
      {
        startedAt: state.startedAt,
        purchaseId: state.purchaseId,
        origin: "http://127.0.0.1:4322",
        listingId: "1",
        paymentRequested: true,
        reusedSavedSignature: true,
        notice: "Confirmation and settlement must be verified separately.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ purchaseId: state.purchaseId, paymentRequested: true }),
  );
} catch (e) {
  writeFileSync(
    ".state/phase3-resume-error.txt",
    e instanceof Error ? e.message : "Unknown failure",
  );
  console.error(
    "Saved purchase resume stopped. Do not initiate another payment; preserve the marker and original quote.",
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
