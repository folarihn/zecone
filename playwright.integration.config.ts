// End-to-end integration: ZecOne payment API + ZecOne web app + the Access Pass
// example merchant, driven in a real browser with an injected test wallet
// (ephemeral key, real EIP-191 signatures). Demo mode only — no funds move.
//
// The suite runs its OWN isolated instances on dedicated ports (defaults below)
// with a temporary database, so it never collides with services you are running
// on the default ports 3000 / 4321 / 4333. Override with ZECONE_IT_*_PORT.
// Run: npm run build:web && npm run test:integration
import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiPort = Number(process.env.ZECONE_IT_API_PORT ?? 4391);
const webPort = Number(process.env.ZECONE_IT_WEB_PORT ?? 3091);
const dappPort = Number(process.env.ZECONE_IT_DAPP_PORT ?? 4393);
const API = `http://127.0.0.1:${apiPort}`;
const WEB = `http://127.0.0.1:${webPort}`;
const DAPP = `http://127.0.0.1:${dappPort}`;
const run = process.env.ZECONE_IT_DIR ?? mkdtempSync(join(tmpdir(), "zecone-it-"));
Object.assign(process.env, { ZECONE_IT_DIR: run, ZECONE_IT_API: API, ZECONE_IT_WEB: WEB, ZECONE_IT_DAPP: DAPP });

const env = {
  NEXT_TELEMETRY_DISABLED: "1",
  ZECONE_PAYMENTS_MODE: "demo",
  ZECONE_PAYMENTS_HOST: "127.0.0.1",
  ZECONE_PAYMENTS_PORT: String(apiPort),
  ZECONE_PAYMENTS_DB: join(run, "payments.sqlite"),
  ZECONE_DEMO_OBSERVER: "1",
  ZECONE_DEMO_OBSERVER_DELAY: "3",
  ZECONE_DEMO_OBSERVER_STEP: "1",
  ZECONE_BASE_URL: API,
  ZECONE_PUBLIC_URL: WEB,
  ZECONE_SIWE_DOMAINS: `127.0.0.1:${webPort},localhost:${webPort},127.0.0.1:${dappPort}`,
  ZECONE_OPERATOR_TOKEN: "",
  ACCESS_PASS_HOST: "127.0.0.1",
  ACCESS_PASS_PORT: String(dappPort),
  ACCESS_PASS_PUBLIC_URL: DAPP,
  ACCESS_PASS_STATE: join(run, "access-pass.json"),
  ZECONE_WEB_URL: WEB,
};
const executablePath = process.env.ZECONE_PW_EXECUTABLE;

export default defineConfig({
  testDir: "tests/integration",
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["json", { outputFile: join(run, "results.json") }]],
  timeout: 90_000,
  webServer: [
    { command: "node --import tsx services/payments/server.ts", url: `${API}/api/v1/health`, reuseExistingServer: false, env, timeout: 60_000 },
    {
      command: `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${webPort}`,
      url: `${WEB}/api/site-health`,
      reuseExistingServer: false,
      env,
      timeout: 120_000,
    },
    { command: "node --import tsx examples/access-pass/server.ts", url: `${DAPP}/api/config`, reuseExistingServer: false, env, timeout: 60_000 },
  ],
  use: {
    browserName: "chromium",
    ...(executablePath ? { launchOptions: { executablePath } } : process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
