// Explicit real-browser steps. Durable markers prevent duplicate payment/quote creation.
import { chromium, expect } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readJson, exclusiveJson } from "../services/execution/io.ts";
import { SeaportBase } from "../services/seaport/adapter.ts";
import type { SeaportConfig } from "../services/seaport/protocol.ts";
import { nftAbi } from "../services/marketplace/purchase.ts";
const mode = process.argv[2],
  root = "docs/phase4c-evidence/base",
  marker = ".state/phase4c-live";
if (
  ![
    "quote",
    "resume-quote",
    "approve",
    "reconcile",
    "payment-review",
    "pay",
    "capture",
  ].includes(mode)
)
  throw Error("Choose an explicit live step");
if (mode !== "capture" && !process.argv.includes("--allow-testnet-spend"))
  throw Error("Explicit live authorization flag required");
const c = readJson<SeaportConfig>(".state/seaport-84532-confirmed.json"),
  b = new SeaportBase(c);
await b.check();
mkdirSync(root, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({
      storageState: ".secrets/phase4c-browser-session.json",
      viewport: { width: 1440, height: 1100 },
    }),
    page = await context.newPage();
  await page.goto("http://127.0.0.1:3210/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Seaport", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your Seaport purchases", exact: true }),
  ).toBeVisible();
  const response = (path: string) =>
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/seaport/${path}`) &&
        r.request().method() === "POST",
      { timeout: 120000 },
    );
  if (mode === "quote" || mode === "resume-quote") {
    if (mode === "resume-quote") {
      if (
        !existsSync(`${marker}.started.json`) ||
        existsSync(`${marker}.quote.json`)
      )
        throw Error("Resume requires the original pre-order attempt");
      const db = new DatabaseSync(".state/purchases.sqlite", {
        readOnly: true,
      });
      try {
        if (
          db
            .prepare(
              "SELECT id FROM purchase_requests WHERE json_extract(intent,'$.kind')='seaport' LIMIT 1",
            )
            .get()
        )
          throw Error(
            "A Seaport order exists; reconcile it without creating another quote",
          );
      } finally {
        db.close();
      }
    } else {
      if (existsSync(`${marker}.started.json`))
        throw Error("Existing live attempt must be reconciled, not replaced");
      exclusiveJson(`${marker}.started.json`, {
        at: new Date().toISOString(),
        balancesBefore: {
          provider: String(await b.public.getBalance({ address: c.provider })),
          seller: String(await b.public.getBalance({ address: c.seller })),
          user: String(await b.public.getBalance({ address: c.user })),
          owner: await b.public.readContract({
            address: c.nft,
            abi: nftAbi,
            functionName: "ownerOf",
            args: [1n],
          }),
        },
      });
    }
    await expect(
      page.getByRole("button", {
        name: "Review Seaport purchase",
        exact: true,
      }),
    ).toBeEnabled({ timeout: 60000 });
    const pending = response("quote");
    await page
      .getByRole("button", { name: "Review Seaport purchase", exact: true })
      .click();
    const r = await pending;
    if (!r.ok())
      throw Error(
        `Quote failed (${r.status()}): ${String((await r.json()).error).slice(0, 300)}`,
      );
    const q = await r.json();
    if (
      q.recipient !== c.user ||
      q.nft !== c.nft ||
      q.tokenId !== "1" ||
      q.price !== "102500000000000" ||
      q.zatoshis !== "1012500" ||
      q.feeAmount !== "2500000000000"
    )
      throw Error("Unexpected live Seaport terms");
    exclusiveJson(`${marker}.quote.json`, q);
    await expect(page.getByRole("dialog")).toContainText(c.user);
    await page.screenshot({ path: `${root}/quote-review.png`, fullPage: true });
    console.log(
      JSON.stringify({
        step: mode,
        id: q.id,
        orderHash: q.orderHash,
        zatoshis: q.zatoshis,
      }),
    );
  } else {
    const q = readJson<any>(`${marker}.quote.json`),
      row = page.locator("article").filter({ hasText: q.id });
    if (mode === "approve") {
      if (existsSync(`${marker}.approved.json`))
        throw Error("Approval already recorded");
      await row
        .getByRole("button", { name: "Review saved Seaport quote" })
        .click();
      await expect(page.getByRole("dialog")).toContainText(c.user);
      await expect(page.getByRole("dialog")).toContainText(q.orderHash);
      const pending = response("approve");
      await page
        .getByRole("button", {
          name: "Approve exact Seaport intent",
          exact: true,
        })
        .click();
      const r = await pending;
      if (!r.ok()) throw Error("Approval failed; reconcile original quote");
      exclusiveJson(`${marker}.approved.json`, {
        at: new Date().toISOString(),
        ...(await r.json()),
      });
      console.log(JSON.stringify({ step: mode, id: q.id }));
    } else if (mode === "reconcile") {
      const pending = response("recheck");
      await row
        .getByRole("button", { name: "Recheck saved Seaport purchase" })
        .click();
      const r = await pending;
      if (!r.ok())
        throw Error(
          `Reconciliation failed (${r.status()}): ${String((await r.json()).error).slice(0, 300)}`,
        );
      const result = await r.json();
      console.log(
        JSON.stringify({
          step: mode,
          id: q.id,
          stage: result.stage,
          status: result.status,
        }),
      );
    } else if (mode === "payment-review" || mode === "pay") {
      if (existsSync(`${marker}.payment-started.json`))
        throw Error("Payment already started; reconcile its original UUID");
      const pending = response("fee");
      await row
        .getByRole("button", {
          name: "Review shielded Seaport payment",
          exact: true,
        })
        .click();
      const r = await pending;
      if (!r.ok()) throw Error("Native fee review failed");
      const fee = await r.json();
      if (BigInt(fee.fee.totalZatoshis) > 1032500n)
        throw Error("Native debit exceeds test bound");
      await expect(page.getByRole("dialog")).toContainText(c.user);
      await page.screenshot({
        path: `${root}/${mode === "pay" ? "payment-approval" : "payment-review"}.png`,
        fullPage: true,
      });
      if (mode === "payment-review") {
        exclusiveJson(`${marker}.fee.json`, fee);
        console.log(
          JSON.stringify({ step: mode, totalZatoshis: fee.fee.totalZatoshis }),
        );
      } else {
        const old = readJson<any>(`${marker}.fee.json`);
        if (BigInt(fee.fee.totalZatoshis) > BigInt(old.fee.totalZatoshis))
          throw Error("Fee increased; review before payment");
        exclusiveJson(`${marker}.payment-started.json`, {
          at: new Date().toISOString(),
          id: q.id,
          quoteId: fee.fee.id,
          totalZatoshis: fee.fee.totalZatoshis,
        });
        const paid = response("pay");
        await page
          .getByRole("button", {
            name: "Send shielded Seaport payment",
            exact: true,
          })
          .click();
        const result = await paid;
        if (!result.ok())
          throw Error("Payment outcome requires reconciliation");
        console.log(
          JSON.stringify({
            step: mode,
            id: q.id,
            status: (await result.json()).status,
          }),
        );
      }
    } else {
      await expect(
        row.getByRole("heading", { name: "Completed", exact: true }),
      ).toBeVisible({ timeout: 60000 });
      await expect(row).toContainText("Verified NFT delivery");
      await expect(
        page.getByRole("button", {
          name: "Review Seaport purchase",
          exact: true,
        }),
      ).toBeVisible({ timeout: 60000 });
      await page.screenshot({
        path: `${root}/wallet-completed.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.getByRole("heading", {
          name: "Your Seaport purchases",
          exact: true,
        }),
      ).toBeVisible();
      if (
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        )
      )
        throw Error("Mobile horizontal overflow");
      await page.screenshot({
        path: `${root}/wallet-completed-mobile.png`,
        fullPage: true,
      });
      console.log(
        "Captured real completed Seaport purchase on desktop and mobile.",
      );
    }
  }
} finally {
  await browser.close();
}
