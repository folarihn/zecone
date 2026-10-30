// Opt-in real Base Sepolia EOA connector proof. It spends user gas only after clicking
// the visible approval in the local wallet popup. Never invoke as part of npm test.
import { chromium, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const marker = ".state/phase2-dapp-live-started.json";
if (!process.argv.includes("--allow-testnet-transaction"))
  throw Error(
    "Use --allow-testnet-transaction after confirming the user EOA has Base Sepolia ETH.",
  );
const prior = existsSync(marker)
  ? (JSON.parse(readFileSync(marker, "utf8")) as {
      startedAt?: string;
      transactionApprovalStarted?: boolean;
      attempts?: number;
      transactionHash?: string;
    })
  : null;
if (prior?.transactionApprovalStarted || prior?.transactionHash)
  throw Error(
    "Live dApp transaction approval was already reached. Inspect the saved request and chain status before retrying.",
  );
const markerData = {
  ...(prior ?? {}),
  startedAt: prior?.startedAt ?? new Date().toISOString(),
  attempts: (prior?.attempts ?? 0) + 1,
  transactionApprovalStarted: false,
  scope:
    "One zero-value self transaction from the user EOA; signatures and testnet gas are also exercised.",
};
writeFileSync(marker, JSON.stringify(markerData, null, 2), {
  flag: "w",
  mode: 0o600,
});
mkdirSync("docs/phase2-evidence", { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({
    storageState: ".secrets/phase1-browser-session.json",
    viewport: { width: 1400, height: 1000 },
  });
  const dapp = await context.newPage(),
    errors: string[] = [];
  dapp.on("pageerror", (e) => errors.push(e.message));
  await dapp.goto("http://127.0.0.1:4321");
  await expect(dapp.locator("#status")).toContainText("Discovered");
  const popupPromise = dapp.waitForEvent("popup");
  await dapp.getByRole("button", { name: "Discover and connect" }).click();
  const wallet = await popupPromise;
  await expect(
    wallet.getByRole("heading", { name: "Connect application" }),
  ).toBeVisible({ timeout: 30000 });
  if (
    (await wallet.locator(".origin-box").innerText()).includes(
      "http://127.0.0.1:4321",
    ) === false
  )
    throw Error("Origin shown in wallet approval did not match fixture dApp.");
  await wallet.getByRole("button", { name: "Approve request" }).click();
  await expect(dapp.locator("#output")).toContainText("0x14a34", {
    timeout: 30000,
  });
  const connectText = await dapp.locator("#output").innerText();
  for (const [button, heading] of [
    ["Request personal_sign", "Review signature"],
    ["Request EIP-712 signature", "Review signature"],
    ["Request zero-value self transaction", "Review transaction"],
  ] as const) {
    const previous = await dapp.locator("#output").innerText();
    await dapp.getByRole("button", { name: button }).click();
    await expect(wallet.getByRole("heading", { name: heading })).toBeVisible({
      timeout: 120000,
    });
    if (button.includes("transaction")) {
      markerData.transactionApprovalStarted = true;
      writeFileSync(marker, JSON.stringify(markerData, null, 2), {
        flag: "w",
        mode: 0o600,
      });
    }
    const review = await wallet.locator(".review-data").innerText();
    if (button.includes("transaction")) {
      for (const term of ["to", "value", "gas", "simulation", "Base L1"])
        if (!review.toLowerCase().includes(term.toLowerCase()))
          throw Error(`Transaction review omitted ${term}.`);
      writeFileSync("docs/phase2-evidence/transaction-review.txt", review);
    }
    await wallet.getByRole("button", { name: "Approve request" }).click();
    await expect
      .poll(() => dapp.locator("#output").innerText(), { timeout: 120000 })
      .not.toBe(previous);
  }
  const txText = await dapp.locator("#output").innerText();
  const match = txText.match(/Success\n(0x[a-fA-F0-9]{64})/);
  if (!match)
    throw Error("No transaction hash returned by approved sendTransaction.");
  const txHash = match[0];
  const dashboard = await context.newPage();
  await dashboard.goto("http://127.0.0.1:3210/");
  await dashboard
    .getByRole("navigation")
    .getByRole("button", { name: "Apps", exact: true })
    .click();
  await dashboard.getByRole("button", { name: "Refresh list" }).click();
  await expect(
    dashboard.getByText("http://127.0.0.1:4321", { exact: true }),
  ).toBeVisible();
  await dashboard.getByRole("button", { name: "Disconnect" }).click();
  await dapp.getByRole("button", { name: "Try after disconnect" }).click();
  await expect(dapp.locator("#output")).toContainText("4100", {
    timeout: 30000,
  });
  const result = {
    observedAt: new Date().toISOString(),
    transport:
      "EIP-1193 over explicit popup; EIP-6963-compatible discovery using the public SDK",
    dappOrigin: "http://127.0.0.1:4321",
    walletOrigin: "http://127.0.0.1:3210",
    accountConnected: connectText.includes("0x"),
    chainId: "0x14a34",
    methods: [
      "eth_requestAccounts",
      "eth_accounts",
      "eth_chainId",
      "personal_sign",
      "eth_signTypedData_v4",
      "eth_sendTransaction",
    ],
    transactionHash: txHash,
    explorer: `https://sepolia.basescan.org/tx/${txHash}`,
    revoked: true,
    unauthorizedAfterRevoke: "4100",
    pageErrors: errors,
  };
  markerData.transactionHash = txHash;
  writeFileSync(marker, JSON.stringify(markerData, null, 2), {
    flag: "w",
    mode: 0o600,
  });
  writeFileSync(
    "docs/phase2-evidence/live-dapp.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (e) {
  writeFileSync(
    ".state/phase2-dapp-error.log",
    e instanceof Error ? (e.stack ?? e.message) : "Unknown error",
  );
  console.error(
    "Live dApp flow stopped. The one-run marker and any signed transaction remain preserved; inspect wallet requests and Base status before retrying.",
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
