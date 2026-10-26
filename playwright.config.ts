import { defineConfig } from "@playwright/test";
export default defineConfig({
  webServer: {
    command:
      "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3211",
    url: "http://127.0.0.1:3211",
    reuseExistingServer: false,
    env: { NEXT_TELEMETRY_DISABLED: "1", ZECONE_SURFACE: "wallet" },
  },
  testDir: "tests/ui",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3211",
    browserName: "chromium",
    ...(process.env.ZECONE_PW_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.ZECONE_PW_EXECUTABLE } }
      : { channel: "msedge" }),
    headless: true,
    trace: "off",
    screenshot: "only-on-failure",
  },
  timeout: 30000,
});
