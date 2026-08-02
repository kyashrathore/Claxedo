import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.CLAXEDO_APP_URL

if (!baseURL) throw new Error("CLAXEDO_APP_URL is required for the deployed WorkGraph browser gate")

export default defineConfig({
  testDir: "./e2e/playwright",
  testMatch: "deployed-workgraph.spec.ts",
  outputDir: "./e2e/playwright/test-results/deployed-workgraph",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "e2e/playwright/report/deployed-workgraph", open: "never" }], ["line"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      // Claxedo's local Playwright suites intentionally use navigator.webdriver
      // as a local-only auth seam. This deployed gate must exercise real Clerk
      // instead, so Chromium exposes the same value as a normal production tab.
      args: ["--disable-blink-features=AutomationControlled"],
    },
  },
})
