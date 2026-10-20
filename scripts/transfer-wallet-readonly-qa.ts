// Mounted wallet + real destination RPC, synthetic public profile, financial mode OFF.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chromium, request } from "@playwright/test";
import assert from "node:assert/strict";
const root = resolve(".state/end-to-end", `mounted-${randomUUID()}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
const report: any = {
  at: new Date().toISOString(),
  syntheticProfile: true,
  realDestinationRpc: true,
  financialCreationEnabled: false,
  liveKeyAccess: false,
  broadcast: false,
};
const probe = createServer();
const free = await new Promise<boolean>((resolve) => {
  probe.once("error", () => resolve(false));
  probe.listen(3210, "127.0.0.1", () => probe.close(() => resolve(true)));
});
if (!free) {
  report.status = "BLOCKED_PORT_IN_USE";
} else {
  const wallets = JSON.parse(readFileSync("docs/PUBLIC_WALLETS.json", "utf8"));
  const profile = {
    displayEvmAddress: wallets.base.user,
    recipients: [wallets.base.user],
    profile: {
      profileId: randomUUID(),
      requestId: randomUUID(),
      relayer: wallets.base.relayer,
      account: "a".repeat(64),
      paymentAddress: "utest1_SYNTHETIC_REVIEW_ONLY_NOT_PAYABLE",
    },
    native: {
      chainId: 84532,
      authorizer: wallets.base.user,
      feeCapWei: "100000000000000",
      origins: [],
    },
  };
  const profilePath = join(root, "public-fixture.json"),
    state = join(root, "wallet");
  writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/functional-wallet.ts",
      profilePath,
      "--state",
      state,
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    },
  );
  let startup = "";
  child.stdout.on("data", (b) => (startup += b));
  child.stderr.resume();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let client: Awaited<ReturnType<typeof request.newContext>> | undefined;
  try {
    const deadline = Date.now() + 90000;
    while (!startup.includes("Economic wallet ready on 127.0.0.1:3210")) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw Error("OWN_SERVER_NOT_READY");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    client = await request.newContext({
      baseURL: "http://127.0.0.1:3210",
      extraHTTPHeaders: { Origin: "http://127.0.0.1:3210" },
    });
    const pairFile = readdirSync(state).find((f) =>
      /^pairing-.*\.private\.json$/.test(f),
    );
    assert.ok(pairFile);
    const token = JSON.parse(readFileSync(join(state, pairFile), "utf8")).token;
    const pair = await client.post("/api/pair", { data: { token } });
    assert.equal(pair.status(), 200);
    const session = await pair.json(),
      headers = { "X-ZecOne-CSRF": session.csrf };
    const navigation = {
      Origin: "",
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    };
    assert.equal(
      (await client.get("/connect", { headers: navigation })).status(),
      200,
    );
    assert.equal(
      (
        await client.get("/api/native-transfer/config", { headers: navigation })
      ).status(),
      403,
    );
    report.publicConnectorNavigation = "PASSED";
    report.crossSiteApiBlocked = true;
    const challenge = await client.post("/api/challenge", {
      data: {},
      headers,
    });
    assert.equal(challenge.status(), 200);
    const c = await challenge.json();
    const consent = await client.post("/api/connect", {
      data: { id: c.id, approved: true },
      headers,
    });
    assert.equal(consent.status(), 200);
    const local = await consent.json();
    assert.equal(local.walletOwnershipVerified, false);
    assert.equal(local.financialAuthority, false);
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({
      storageState: await client.storageState(),
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:3210/?view=Send%20%2F%20Receive");
    const panel = page.getByRole("region", {
      name: "ZEC-funded native transfer",
    });
    await panel.waitFor();
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/native-transfer/review") &&
        r.request().method() === "POST",
      { timeout: 60000 },
    );
    await panel
      .getByRole("button", { name: "Review native delivery", exact: true })
      .click();
    const q = await response;
    assert.equal(q.status(), 200);
    const quote = await q.json();
    assert.equal(quote.financialOrderCreated, false);
    assert.equal(quote.executionAuthorized, false);
    assert.equal(
      await panel
        .getByRole("button", { name: "Authorize this payment request" })
        .count(),
      0,
    );
    await page.screenshot({
      path: join(root, "wallet-local-only.png"),
      fullPage: true,
    });
    const db = new DatabaseSync(join(state, "review.sqlite"), {
      readOnly: true,
    });
    try {
      for (const table of ["orders", "payments", "native_transfer_authority"])
        assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0);
    } finally {
      db.close();
    }
    report.status = "PASSED";
    report.liveRpcSimulation = "PASSED";
    report.ordersCreated = 0;
    report.paymentsVerified = 0;
    report.signaturesCreated = 0;
    report.confidence = "PRIMARY_ONLY";
  } catch {
    report.status = "BLOCKED_OR_FAILED";
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await client?.dispose();
    child.kill();
  }
}
mkdirSync("docs/end-to-end-evidence", { recursive: true });
writeFileSync(
  "docs/end-to-end-evidence/mounted-wallet.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
