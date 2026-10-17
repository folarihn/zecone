// Real isolated backend and existing real route quote; NO payment/signing/broadcast.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
let cookies: any[], csrf: string;
test.beforeAll(async ({ request }) => {
  const token = JSON.parse(
    readFileSync(".state/phase7c/browser/pairing.json", "utf8"),
  ).token;
  const paired = await request.post("/api/pair", {
    headers: { Origin: "http://127.0.0.1:3210" },
    data: { token },
  });
  expect(paired.ok()).toBe(true);
  csrf = (await paired.json()).csrf;
  const headers = { Origin: "http://127.0.0.1:3210", "X-ZecOne-CSRF": csrf };
  const challenge = await request.post("/api/challenge", { headers, data: {} });
  expect(challenge.ok()).toBe(true);
  const connected = await request.post("/api/connect", {
    headers,
    data: { id: (await challenge.json()).id, approved: true },
  });
  expect(connected.ok()).toBe(true);
  cookies = (await request.storageState()).cookies;
  await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/phase7c.ts",
      "attach-history",
      "--allow-local-history-recovery",
    ],
    { windowsHide: true },
  );
});
test.beforeEach(async ({ context }) => context.addCookies(cookies));
test("real swap backend exposes only a scoped immutable checkout without payment records", async ({
  page,
}) => {
  const c = await page.request.get("/api/solana-swap/config");
  expect(c.ok()).toBe(true);
  const config = await c.json();
  const q = await page.request.post("/api/solana-swap/quote", {
    headers: { Origin: "http://127.0.0.1:3210", "X-ZecOne-CSRF": csrf },
    data: { recipient: config.freshRecipient },
  });
  expect(q.ok()).toBe(true);
  const view = await q.json();
  expect(view.swap.minimumOut).toMatch(/^[1-9]\d*$/);
  if (process.env.ZECONE_PHASE7C_FINALIZED === "1") {
    expect(view.state).toBe("COMPLETED");
    expect(view.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(BigInt(view.deliveredAmount)).toBeGreaterThanOrEqual(
      BigInt(view.swap.minimumOut),
    );
  } else expect(view.signature).toBeNull();
  for (const field of [
    "paymentAddress",
    "paymentTxs",
    "profileId",
    "requestId",
    "relayer",
    "fullViewingKey",
    "wire",
  ])
    expect(view[field]).toBeUndefined();
});
test("real mobile swap review is accessible and makes public-ownership limits clear", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/?view=Solana");
  await expect(
    page.getByRole("heading", {
      name: "Shielded ZEC-funded Solana token swap",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Solana swap transactions and token ownership remain public/,
    ),
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
  await page.screenshot({
    path: "docs/phase7c-evidence/real-swap-mobile.png",
    fullPage: true,
  });
});
test("real swap backend rejects arbitrary accounts, URL identifiers and all spending endpoints", async ({
  page,
}) => {
  expect(
    (await page.request.get("/api/solana/accounts")).status(),
  ).toBeGreaterThanOrEqual(400);
  expect(
    (
      await page.request.get("/api/solana-swap/status?orderId=untrusted")
    ).status(),
  ).toBeGreaterThanOrEqual(400);
  for (const path of ["execute", "broadcast", "sign", "refund"]) {
    const r = await page.request.post(`/api/solana-swap/${path}`, {
      headers: { Origin: "http://127.0.0.1:3210", "X-ZecOne-CSRF": csrf },
      data: { instructions: ["untrusted"] },
    });
    expect(r.status()).toBeGreaterThanOrEqual(400);
  }
});
