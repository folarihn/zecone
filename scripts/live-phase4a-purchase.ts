// One explicitly authorized UI purchase per testnet. Never called by tests.
import { chromium, expect } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { exclusiveJson, readJson } from "../services/execution/io.ts";
import { network } from "../services/evm/networks.ts";
import {
  PurchaseBase,
  priceZatoshis,
  purchaseTyped,
  multichainExecutorAbi,
  type PurchaseIntent,
  type MarketConfig,
} from "../services/marketplace/purchase.ts";
import { encodeFunctionData, type Address } from "viem";
const id = Number(process.argv[2]),
  n = network(id);
if (id === 84532 || !process.argv.includes("--allow-testnet-spend"))
  throw Error("Explicit new-testnet spend required");
const marker = `.state/phase4a-live-${id}.json`,
  evidence = `docs/phase4a-evidence/${id}`;
if (existsSync(marker))
  throw Error(
    "Existing attempt: reconcile saved order, never initiate another payment",
  );
const c = readJson<MarketConfig & { seller: Address; user: Address }>(
    n.deploymentFile,
  ),
  b = new PurchaseBase(c);
await b.check();
const state: any = {
  chainId: id,
  startedAt: new Date().toISOString(),
  paymentApprovalStarted: false,
  scope: "One NFT listing 1 purchase to the existing user EOA",
  zatoshis: priceZatoshis(100000000000000n, id).toString(),
  balancesBefore: {
    provider: (
      await b.public.getBalance({ address: b.account.address })
    ).toString(),
    seller: (await b.public.getBalance({ address: c.seller })).toString(),
    user: (await b.public.getBalance({ address: c.user })).toString(),
  },
};
exclusiveJson(marker, state);
mkdirSync(evidence, { recursive: true });
const save = () =>
  writeFileSync(marker, JSON.stringify(state, null, 2), { mode: 0o600 });
const browser = await chromium.launch({ channel: "msedge", headless: true });
let phase = "browser";
try {
  const context = await browser.newContext({
    storageState: ".secrets/phase4a-browser-session.json",
    viewport: { width: 1440, height: 1050 },
  });
  const market = await context.newPage();
  await market.goto(c.origin);
  await market.locator("#network").selectOption(String(id));
  await expect(market.locator("#network-badge")).toContainText(
    n.name.toUpperCase(),
  );
  await expect(market.locator(".card")).toHaveCount(3, { timeout: 60000 });
  const waiting = context.waitForEvent("page");
  await market
    .getByRole("button", { name: "Connect ZecOne", exact: true })
    .click();
  const popup = await waiting;
  await popup.waitForLoadState();
  phase = "origin-and-network";
  for (let i = 0; i < 100; i++) {
    if ((await market.locator("#account").textContent())?.includes(c.user))
      break;
    const approve = popup.getByRole("button", {
      name: "Approve request",
      exact: true,
    });
    if (await approve.isVisible()) {
      await expect(popup.locator(".origin-box")).toContainText(c.origin);
      await popup.screenshot({
        path: `${evidence}/connection-${i}.png`,
        fullPage: true,
      });
      await approve.click();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await expect(market.locator("#account")).toContainText(c.user);
  await expect(market.locator("#network")).toHaveValue(String(id));
  await market.screenshot({
    path: `${evidence}/marketplace-before.png`,
    fullPage: true,
  });
  phase = "quote";
  await market
    .locator(".card")
    .first()
    .getByRole("button", { name: "Pay with shielded ZEC" })
    .click();
  await expect(
    popup.getByRole("heading", { name: "Review marketplace quote" }),
  ).toBeVisible({ timeout: 60000 });
  const review = popup.getByRole("dialog");
  await expect(review).toContainText(state.zatoshis);
  await expect(review).toContainText(String(id));
  await expect(review).toContainText(n.name);
  await expect(review).toContainText(c.user);
  await expect(review).toContainText(c.marketplace);
  await popup.screenshot({
    path: `${evidence}/quote-approval.png`,
    fullPage: true,
  });
  await popup
    .getByRole("button", { name: "Approve purchase quote", exact: true })
    .click();
  await expect(
    popup.getByRole("button", { name: "Review Zcash fee" }),
  ).toBeVisible({ timeout: 120000 });
  state.purchaseId = await market.evaluate(
    (chain) => localStorage.getItem(`zecone:purchase:${chain}`),
    id,
  );
  if (!state.purchaseId) throw Error("Missing durable purchase ID");
  save();
  phase = "destination-gas";
  const journal = new DatabaseSync(".state/purchases.sqlite", {
    readOnly: true,
  });
  let intent: PurchaseIntent;
  try {
    const row = journal
      .prepare(
        "SELECT o.intent FROM orders o JOIN purchase_requests p ON p.order_id=o.id WHERE p.id=?",
      )
      .get(state.purchaseId) as any;
    if (!row) throw Error("Missing signed order");
    intent = JSON.parse(row.intent);
  } finally {
    journal.close();
  }
  const call = {
    account: b.account.address,
    to: c.executor,
    value: BigInt(intent.price),
    data: encodeFunctionData({
      abi: multichainExecutorAbi,
      functionName: "execute",
      args: [
        {
          ...purchaseTyped(intent).message,
          sourceNetwork: intent.sourceNetwork!,
          provider: intent.provider!,
          adapter: intent.adapter!,
        },
        intent.signature,
      ],
    }),
  };
  await b.public.call(call);
  const gas = ((await b.public.estimateGas(call)) * 12n) / 10n + 1n,
    fees = await b.public.estimateFeesPerGas();
  if (
    gas > n.maxGas ||
    fees.maxFeePerGas > n.maxFee ||
    gas * fees.maxFeePerGas > n.gasBudget
  )
    throw Error(
      "Exact settlement estimate exceeds approved chain policy; no ZEC sent",
    );
  writeFileSync(
    `${evidence}/prepayment-gas.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        chainId: id,
        purchaseId: state.purchaseId,
        gasLimit: gas.toString(),
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maximumFeeWei: (gas * fees.maxFeePerGas).toString(),
        gasBudgetWei: n.gasBudget.toString(),
        simulationSucceeded: true,
        transactionSent: false,
      },
      null,
      2,
    ),
  );
  phase = "fee";
  await popup.getByRole("button", { name: "Review Zcash fee" }).click();
  await expect(
    popup.getByRole("heading", { name: "Authorize shielded payment" }),
  ).toBeVisible({ timeout: 120000 });
  const text = await review.innerText(),
    amount = id === 11155111 ? "0.03 TAZ" : "0.015 TAZ";
  if (
    !text.includes(amount) ||
    !text.includes("Maximum Zcash fee") ||
    !text.includes(c.user) ||
    !text.includes(n.name)
  )
    throw Error("Unexpected payment terms");
  await popup.screenshot({
    path: `${evidence}/payment-approval.png`,
    fullPage: true,
  });
  state.paymentReview = text;
  state.paymentApprovalStarted = true;
  save();
  phase = "payment";
  await popup
    .getByRole("button", { name: "Approve & pay test ZEC", exact: true })
    .click();
  await expect(review).not.toBeVisible({ timeout: 90000 });
  state.paymentRequested = true;
  save();
  writeFileSync(
    `${evidence}/browser-start.json`,
    JSON.stringify(
      {
        at: state.startedAt,
        chainId: id,
        purchaseId: state.purchaseId,
        user: c.user,
        listingId: "1",
        paymentRequested: true,
        notice:
          "Awaiting independently verified payment and destination confirmations",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      chainId: id,
      purchaseId: state.purchaseId,
      paymentRequested: true,
    }),
  );
} catch (e) {
  state.errorPhase = phase;
  save();
  writeFileSync(
    `.state/phase4a-browser-${id}-error.txt`,
    e instanceof Error ? e.message : "Unknown error",
  );
  console.error(
    `Live UI stopped at ${phase}; preserve marker and reconcile the original purchase.`,
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
