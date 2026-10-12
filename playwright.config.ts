import { defineConfig } from "@playwright/test";
export default defineConfig({
  webServer: {
    command:
      "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3211",
    url: "http://127.0.0.1:3211",
    reuseExistingServer: false,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
  },
  testDir: "tests/ui",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3211",
    browserName: "chromium",
    channel: "msedge",
    headless: true,
    trace: "off",
    screenshot: "only-on-failure",
  },
  timeout: 30000,
});
