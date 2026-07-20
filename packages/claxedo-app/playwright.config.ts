import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4455)
process.env.PLAYWRIGHT_PORT ??= String(port)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`
const reuse = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1"
const suite = process.env.CLAXEDO_E2E_SUITE ?? "happy"
const video = process.env.PLAYWRIGHT_VIDEO === "1" || suite === "core" ? "on" : "retain-on-failure"
const grep = suite === "happy" ? /@happy/ : suite === "core" ? /@core/ : undefined
const workGraphReal = process.env.CLAXEDO_WORKGRAPH_REAL_E2E === "1"
const workGraphApiPort = Number(process.env.CLAXEDO_WORKGRAPH_E2E_API_PORT ?? 4311)
// CLAXEDO_E2E_PREBUILT=1 serves a production build via `vite preview` instead
// of the dev server. CI needs this: cold on-demand dev transforms on a 2-core
// runner push every first navigation past the expect timeouts (the suite went
// 188-failed/2.5h under dev serving, all toBeVisible timeouts). Mocks are
// page.route interceptions, so serving mode is behavior-invisible.
const prebuilt = process.env.CLAXEDO_E2E_PREBUILT === "1"
const webServer =
  process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1"
    ? undefined
    : {
        command: `${workGraphReal ? `bun --cwd ../workgraph run build && VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:${workGraphApiPort} ` : ""}${
          prebuilt
            ? `bun run build && bun x vite preview --config vite.cloud.config.ts --port ${port} --strictPort`
            : `bun run dev -- --port ${port}`
        }`,
        url: baseURL,
        reuseExistingServer: reuse,
        timeout: prebuilt ? 600_000 : 120_000,
      }

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: "**/deployed-workgraph.spec.ts",
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
      // Mobile smoke specs opt into the `mobile` project below (`--project=mobile`);
      // they must never also run at desktop viewport as part of the default/@core
      // suite here.
      testIgnore: ["**/mobile-*.spec.ts", "**/deployed-workgraph.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // `devices["iPhone 13"]` per LLD WP-03 step 1 / appendix responsive refactor
      // step ("Add a `devices['iPhone 13']`-style mobile project to
      // playwright.config.ts"). Only `mobile-*.spec.ts` files run here — never
      // selected implicitly by the default `testMatch`, only via `--project=mobile`.
      // `devices["iPhone 13"]` defaults to WebKit (`defaultBrowserType`), but only
      // Chromium is provisioned in this environment (and by every other project here)
      // — override `browserName` so the mobile project gets the same viewport/touch/
      // UA emulation on the browser this repo actually installs.
      name: "mobile",
      testMatch: ["**/mobile-*.spec.ts"],
      testIgnore: ["**/deployed-workgraph.spec.ts"],
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
})
