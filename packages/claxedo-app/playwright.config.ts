import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4455)
process.env.PLAYWRIGHT_PORT ??= String(port)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`
const reuse = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1"
// SUITE LANE REGISTRY — the single source of truth for `CLAXEDO_E2E_SUITE`.
// A spec is only ever executed by a lane whose tag it carries, so a spec with no
// recognised lane tag runs in NO lane and nobody notices: that is exactly how
// `a11y-sweep.spec.ts` sat tagged `@happy` (a dead pre-consolidation lane that no
// script and no CI job selected) and went silently unexecuted. Keep this object the
// ONLY place suite names are decided, and keep it in sync with the lane-tag list in
// `src/architecture/e2e-suite-tags.guard.test.ts`, which fails if any spec under
// `e2e/playwright/` carries none of these tags.
//   core      — Tier M (`installMockRuntime`, zero real network, per e2e/INVARIANTS.md
//               rule 6). The lane CI actually watches: `test:e2e:core:base`, sharded
//               12-way on every PR. This is the default, so a bare `test:e2e` runs
//               the watched lane instead of nothing.
//   live      — Tier L (`live-*.spec.ts`): real claxedo-server / real agent binaries /
//               real credentials. Deliberately NOT in CI — no credentials there.
//   marketing — `marketing-screenshots.spec.ts`, a capture tool that writes PNGs into
//               `packages/claxedo-web/public/screenshots`. Never in CI: it rewrites
//               committed assets.
//   all       — no tag filter; includes the lanes CI cannot run. Local/nightly only.
// `@workgraph-real` is not a lane of its own: it is a sub-selector inside `core`,
// carved out of the sharded lane by `test:e2e:core:base`'s `--grep-invert` and run by
// the separate `e2e (workgraph-real)` CI job. Same for the `@documents-*-canary` tags.
const suiteGrep = {
  core: /@core/,
  live: /@live/,
  marketing: /@marketing/,
  all: undefined,
} satisfies Record<string, RegExp | undefined>
const suite = process.env.CLAXEDO_E2E_SUITE ?? "core"
if (!(suite in suiteGrep)) {
  // Fail loudly rather than fall through to "no grep = run everything": a typo'd
  // suite name silently running Tier L against no backend is worse than a crash.
  throw new Error(
    `CLAXEDO_E2E_SUITE="${suite}" is not a known suite. Known suites: ${Object.keys(suiteGrep).join(", ")}.`,
  )
}
const grep = suiteGrep[suite as keyof typeof suiteGrep]
// PLAYWRIGHT_VIDEO=0 is an explicit off-switch: the old `|| suite === "core"`
// override recorded video for every core test regardless, ballooning CI shard
// artifacts (and slowing every local run) with videos of passing tests.
const video =
  process.env.PLAYWRIGHT_VIDEO === "0"
    ? "retain-on-failure"
    : process.env.PLAYWRIGHT_VIDEO === "1" || suite === "core"
      ? "on"
      : "retain-on-failure"
const workGraphReal = process.env.CLAXEDO_WORKGRAPH_REAL_E2E === "1"
const workGraphApiPort = Number(process.env.CLAXEDO_WORKGRAPH_E2E_API_PORT ?? 4311)
// Tier R (`real-*.spec.ts`, @tier-real): real claxedo-server + real harness
// binaries against a scripted model endpoint. Same carve-out mechanics as
// @workgraph-real: its own CI job, its own backend port baked into the app
// build — a shard cannot host it because a shard's build points at :3001.
const tierReal = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const tierRealBackendPort = Number(process.env.CLAXEDO_TIER_REAL_BACKEND_PORT ?? 4317)
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
        command: `${workGraphReal ? `bun --cwd ../workgraph run build && VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:${workGraphApiPort} ` : ""}${tierReal ? `VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:${tierRealBackendPort} ` : ""}${
          prebuilt
            ? // VITE_CLAXEDO_E2E=1 keeps the e2e-only harness seams (test-auth
              // bypass, /__e2e/* routes, the server-URL override) alive in the
              // production bundle — they are tree-shaken out of any build that
              // does NOT set this flag, so real production is unaffected. The
              // dev server needs no flag (import.meta.env.DEV covers it).
              `VITE_CLAXEDO_E2E=1 bun run build && bun x vite preview --config vite.cloud.config.ts --port ${port} --strictPort`
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
  // No retries, anywhere. CI used to retry twice, which silently converted flakes
  // into passes: three separate flaky tests survived unnoticed that way, and one
  // (`core-first-prompt-local` behavior 5) turned out to be a HARD 15/15 failure
  // locally that only ever looked intermittent because slower runners crossed a
  // timing boundary. A retry budget does not make a suite trustworthy, it makes an
  // untrustworthy suite quiet. A flake is now a red build, which is the point.
  //
  // KNOWN RESIDUAL RISK: the draft->session handoff has an unfixed app race — a
  // confirmed `POST /session -> 201` sometimes leaves the URL on the draft route.
  // It is shared by the `sendPrompt` helper and therefore reachable from many core
  // specs under heavy load. If CI goes red there, fix the race; do not restore
  // retries.
  retries: 0,
  // Under a prebuilt static server, per-file parallelism is safe: mocks are
  // page-scoped route interceptions and every spec keys its own /tmp dir. The
  // single-worker pin only protects dev-serving runs (module-graph contention).
  // 2 workers, not 4: CI runners have 4 vCPUs and four chromiums starve the
  // heavyweight dialog specs (settings-auth cluster timeouts at workers=4).
  workers: suite === "all" || suite === "core" ? (prebuilt ? 2 : 1) : undefined,
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
