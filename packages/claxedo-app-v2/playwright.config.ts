import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e/flows",
  testMatch: /\d\d-[a-z0-9-]+\.spec\.ts$/,
  globalSetup: "./e2e/harness/global-setup.ts",
  outputDir: "./e2e/results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { outputFolder: "e2e/report", open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "web",
      grepInvert: /@desktop/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "phone",
      grepInvert: /@desktop/,
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "desktop",
      grep: /@desktop/,
    },
  ],
})
