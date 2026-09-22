import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90000,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: { headless: true, screenshot: "only-on-failure" },
});
