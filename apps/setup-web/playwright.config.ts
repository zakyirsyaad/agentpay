import { defineConfig } from "@playwright/test";

const browserChannel = process.env.AGENTPAY_E2E_BROWSER_CHANNEL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  expect: { timeout: 10_000 },
  outputDir: "./test-results",
  use: {
    browserName: "chromium",
    ...(browserChannel ? { channel: browserChannel } : {}),
    headless: true,
    trace: "retain-on-failure",
  },
});
