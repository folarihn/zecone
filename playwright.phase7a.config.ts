import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/phase7a",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  timeout: 60000,
  webServer: {
    command: "node --import tsx scripts/phase7a-server.ts",
    url: "http://127.0.0.1:3210/api/health",
    reuseExistingServer: false,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
  },
  use: {
    baseURL: "http://127.0.0.1:3210",
    browserName: "chromium",
    channel: "msedge",
    headless: true,
    trace: "off",
    screenshot: "off",
  },
});
