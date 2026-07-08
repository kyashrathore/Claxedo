import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4455)
process.env.PLAYWRIGHT_PORT ??= String(port)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`
const reuse = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1"
const suite = process.env.CLAXEDO_E2E_SUITE ?? "happy"
const video = process.env.PLAYWRIGHT_VIDEO === "1" || suite === "core" ? "on" : "retain-on-failure"
const grep = suite === "happy" ? /@happy/ : suite === "core" ? /@core/ : undefined
const webServer = process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1"
  ? undefined
  : {
      command: `bun run dev -- --port ${port}`,
      url: baseURL,
      reuseExistingServer: reuse,
      timeout: 120_000,
    }

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  grep,
  outputDir: "./e2e/playwright/test-results",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : suite === "all" ? 1 : 0,
  workers: suite === "all" || suite === "core" ? 1 : undefined,
  reporter: [["html", { outputFolder: "e2e/playwright/report", open: "never" }], ["line"]],
  webServer,
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
