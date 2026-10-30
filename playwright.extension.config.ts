import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/extension",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  timeout: 30000,
  use: { trace: "off" },
});
