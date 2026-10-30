import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/phase6c",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  timeout: 30000,
  webServer: {
    command: "node --import tsx scripts/phase6c-viewer.ts",
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
