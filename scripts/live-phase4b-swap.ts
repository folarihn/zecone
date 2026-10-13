// Real browser actions. Each step is explicit, durable, and refuses duplicate payments.
import { chromium, expect } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { readJson, exclusiveJson } from "../services/execution/io.ts";
import { SwapBase } from "../services/swaps/adapter.ts";
import { tokenAbi, type SwapConfig } from "../services/swaps/intent.ts";
const mode = process.argv[2],
  root = "docs/phase4b-evidence/base",
  marker = ".state/phase4b-live";
if (!["quote", "approve", "payment-review", "pay", "capture"].includes(mode))
  throw Error("Choose an explicit live step");
if (mode !== "capture" && !process.argv.includes("--allow-testnet-spend"))
  throw Error("Explicit live authorization flag required");
const c = readJson<SwapConfig>(".state/swap-84532-confirmed.json"),
  b = new SwapBase(c);
await b.check();
mkdirSync(root, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({
      storageState: ".secrets/phase4b-browser-session.json",
      viewport: { width: 1440, height: 1100 },
    }),
    page = await context.newPage();
  await page.goto("http://127.0.0.1:3210/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Tokens", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your token purchases" }),
  ).toBeVisible();
  if (mode === "quote") {
    if (existsSync(`${marker}.started.json`))
      throw Error(
        "A live attempt already exists; inspect it instead of creating another quote",
      );
    const provider = await b.public.getBalance({ address: c.provider }),
      user = await b.public.getBalance({ address: c.user }),
      token = await b.public.readContract({
        address: c.token,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [c.user],
      });
    exclusiveJson(`${marker}.started.json`, {
      at: new Date().toISOString(),
      balancesBefore: {
        provider: provider.toString(),
        user: user.toString(),
        token: token.toString(),
      },
    });
    await expect(page.getByLabel("Purchase input (test ETH)")).toHaveValue(
      "0.0001",
    );
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/swaps/quote") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Get AMM quote", exact: true })
      .click();
    const res = await response;
    if (!res.ok()) throw Error("Quote failed; inspect the existing attempt");
    const quote = await res.json();
    if (
      quote.intent.recipient !== c.user ||
      quote.intent.maxNative !== "100000000000000" ||
      quote.zatoshis !== "1000000" ||
      quote.slippageBps !== 100
    )
      throw Error("Unexpected live terms");
    exclusiveJson(`${marker}.quote.json`, quote);
    await expect(page.getByRole("dialog")).toContainText(
      "Base Sepolia · chain 84532",
    );
    await expect(page.getByRole("dialog")).toContainText(c.token);
    await page.screenshot({ path: `${root}/quote-review.png`, fullPage: true });
    console.log(
      JSON.stringify({
        step: mode,
        id: quote.id,
        expectedOut: quote.expectedOut,
        minOut: quote.minOut,
        zec: quote.zatoshis,
      }),
    );
  } else {
    const quote = readJson<any>(`${marker}.quote.json`);
    // Reopen only the existing reviewed order via same-origin authenticated API; never create a new quote.
    const call = async (path: string, body: any) =>
      page.evaluate(
        async ({ path, body }) => {
          const s = await (await fetch("/api/session")).json();
          const r = await fetch(`/api/swaps/${path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-ZecOne-CSRF": s.csrf,
            },
            body: JSON.stringify(body),
          });
          if (!r.ok) throw Error(`Local operation failed (${r.status})`);
          return r.json();
        },
        { path, body },
      );
    if (mode === "approve") {
      if (existsSync(`${marker}.approved.json`))
        throw Error("Intent approval already recorded");
      await page
        .locator("article")
        .filter({ hasText: quote.id })
        .getByRole("button", { name: "Review saved quote" })
        .click();
      await expect(page.getByRole("dialog")).toContainText(c.user);
      await expect(page.getByRole("dialog")).toContainText(
        "Base Sepolia · chain 84532",
      );
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/swaps/approve") &&
          r.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Approve exact swap intent", exact: true })
        .click();
      const res = await response;
      if (!res.ok())
        throw Error("Intent approval failed; reconcile saved request");
      const result = await res.json();
      exclusiveJson(`${marker}.approved.json`, {
        at: new Date().toISOString(),
        ...result,
      });
      console.log(JSON.stringify({ step: mode, id: quote.id }));
    } else if (mode === "payment-review") {
      if (existsSync(`${marker}.payment-started.json`))
        throw Error("Payment already started; reconcile the original request");
      const row = page.locator("article").filter({ hasText: quote.id });
      await expect(row).toBeVisible();
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/swaps/fee") && r.request().method() === "POST",
      );
      await row
        .getByRole("button", { name: "Review shielded payment" })
        .click();
      const res = await response;
      if (!res.ok()) throw Error("Native fee review failed");
      const fee = await res.json();
      if (BigInt(fee.fee.totalZatoshis) > 1020000n)
        throw Error("Native total exceeds live demonstration bound");
      exclusiveJson(`${marker}.fee.json`, fee);
      await expect(page.getByRole("dialog")).toContainText(
        "Approve shielded swap payment",
      );
      await page.screenshot({
        path: `${root}/payment-review.png`,
        fullPage: true,
      });
      console.log(
        JSON.stringify({
          step: mode,
          id: quote.id,
          totalZatoshis: fee.fee.totalZatoshis,
        }),
      );
    } else if (mode === "pay") {
      const approvedFee = readJson<any>(`${marker}.fee.json`);
      if (existsSync(`${marker}.payment-started.json`))
        throw Error("Payment already started; reconcile its original request");
      const feeResponse = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/swaps/fee") && r.request().method() === "POST",
      );
      await page
        .locator("article")
        .filter({ hasText: quote.id })
        .getByRole("button", { name: "Review shielded payment" })
        .click();
      const feeRes = await feeResponse;
      if (!feeRes.ok()) throw Error("Fresh payment review failed");
      const fee = await feeRes.json();
      if (BigInt(fee.fee.totalZatoshis) > BigInt(approvedFee.fee.totalZatoshis))
        throw Error("Native fee increased; inspect a new review before paying");
      await expect(page.getByRole("dialog")).toContainText(c.user);
      await page.screenshot({
        path: `${root}/payment-approval.png`,
        fullPage: true,
      });
      exclusiveJson(`${marker}.payment-started.json`, {
        at: new Date().toISOString(),
        id: quote.id,
        quoteId: fee.fee.id,
        totalZatoshis: fee.fee.totalZatoshis,
      });
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/swaps/pay") && r.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Send shielded payment", exact: true })
        .click();
      const res = await response;
      if (!res.ok())
        throw Error("Payment outcome requires journal reconciliation");
      const result = await res.json();
      console.log(
        JSON.stringify({ step: mode, id: quote.id, status: result.status }),
      );
    } else {
      await expect(page.getByLabel("Output token")).toBeVisible({timeout:60000});
      await expect(page.locator("article").filter({hasText:quote.id}).getByRole("heading",{name:"Completed",exact:true})).toBeVisible();
      await page.screenshot({
        path: `${root}/wallet-completed.png`,
        fullPage: true,
      });
      console.log("Captured actual token purchase state.");
    }
  }
} finally {
  await browser.close();
}
