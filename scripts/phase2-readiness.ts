// Read-only wallet balance/session preflight for Phase 2. Never reads or prints secrets.
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const sessionFile = existsSync(".secrets/phase2-browser-session.json")
    ? ".secrets/phase2-browser-session.json"
    : ".secrets/phase1-browser-session.json";
  const context = await browser.newContext({ storageState: sessionFile }),
    page = await context.newPage();
  await page.goto("http://127.0.0.1:3210/");
  const result = await page.evaluate(async () => {
    const session = await (
      await fetch("/api/session", { cache: "no-store" })
    ).json();
    if (!session.connected) return { authenticated: false };
    const d = await (
      await fetch("/api/dashboard", { cache: "no-store" })
    ).json();
    return {
      authenticated: true,
      address: d.address,
      network: "Base Sepolia / Zcash Testnet",
      baseWei: d.base?.wei ?? null,
      zcashSpendableZatoshis: d.zcash?.spendableZatoshis ?? null,
      zcashTip: d.zcash?.tip ?? null,
      zcashScanned: d.zcash?.scanned ?? null,
      zcashHealth: d.health?.zcash,
      baseHealth: d.health?.base,
      checkouts: (d.checkouts ?? []).map((c: any) => ({
        kind: c.kind,
        status: c.status,
        stage: c.stage,
        confirmations: c.confirmations,
      })),
    };
  });
  console.log(
    JSON.stringify({
      ...result,
      actionContractConfigured: existsSync(".state/actions-confirmed.json"),
    }),
  );
  if (!result.authenticated) process.exitCode = 2;
} finally {
  await browser.close();
}
