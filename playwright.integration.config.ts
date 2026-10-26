// End-to-end integration: ZecOne payment API + ZecOne web app + the Access Pass
// example merchant, driven in a real browser with an injected test wallet
// (ephemeral key, real EIP-191 signatures). Demo mode only — no funds move.
// Run: npm run build:web && npm run test:integration
import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = process.env.ZECONE_IT_DIR ?? mkdtempSync(join(tmpdir(), "zecone-it-"));
process.env.ZECONE_IT_DIR = run;
const env = {
  NEXT_TELEMETRY_DISABLED: "1",
  ZECONE_PAYMENTS_DB: join(run, "payments.sqlite"),
  ZECONE_DEMO_OBSERVER_DELAY: "3",
  ZECONE_DEMO_OBSERVER_STEP: "1",
  ZECONE_PUBLIC_URL: "http://localhost:3000",
  ZECONE_SIWE_DOMAINS: "localhost:3000,127.0.0.1:3000,127.0.0.1:4333",
  ZECONE_OPERATOR_TOKEN: "",
  ACCESS_PASS_STATE: join(run, "access-pass.json"),
  ZECONE_WEB_URL: "http://localhost:3000",
};
const executablePath = process.env.ZECONE_PW_EXECUTABLE;

export default defineConfig({
  testDir: "tests/integration",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  timeout: 90_000,
  webServer: [
    { command: "node --import tsx services/payments/server.ts", url: "http://127.0.0.1:4321/api/v1/health", reuseExistingServer: false, env },
    {
      command: "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3000",
      url: "http://127.0.0.1:3000/security",
      reuseExistingServer: false,
      env,
    },
    { command: "node --import tsx examples/access-pass/server.ts", url: "http://127.0.0.1:4333/api/config", reuseExistingServer: false, env },
  ],
  use: {
    browserName: "chromium",
    ...(executablePath ? { launchOptions: { executablePath } } : process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
    trace: "off",
    screenshot: "only-on-failure",
  },
});
