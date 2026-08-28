import { defineConfig, devices } from "@playwright/test"
import { resolveE2EAuthMode } from "./e2e/auth-mode"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4455)
process.env.PLAYWRIGHT_PORT ??= String(port)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`
const reuse = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1"
// Browser specs run in two explicit identity modes. `test-user` preserves the
// historical webdriver-authenticated lane. `local-unsigned` is the real
// loopback/no-user composition: auth surfaces stay mounted, but there is no
// Clerk key and both the webdriver and stored test-auth bypasses are disabled.
// Keeping this at the Vite process boundary makes every spec in a run exercise
// the same app composition; individual specs cannot accidentally drift back to
// Test User because of Playwright's `navigator.webdriver` value.
const authMode = resolveE2EAuthMode()
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
//               six-way per auth mode on every PR. This is the default, so a bare `test:e2e` runs
//               the watched lane instead of nothing.
//   live      — Tier L (`live-*.spec.ts`): real claxedo-server / real agent binaries /
//               real credentials. Deliberately NOT in CI — no credentials there.
//   marketing — `marketing-screenshots.spec.ts`, a capture tool that writes PNGs into
//               `packages/claxedo-web/public/screenshots`. Never in CI: it rewrites
//               committed assets.
//   all       — no tag filter; includes the lanes CI cannot run. Local/nightly only.
// `@workgraph-real` is not a lane of its own: it is a sub-selector inside `core`,
// carved out of the sharded lane by `test:e2e:core:base`'s `--grep-invert`. Its
// dedicated CI jobs are temporarily paused, while the explicit local/manual commands
// remain available. The `@documents-*-canary` tags are also sub-selectors.
// `@surface-desktop` / `@surface-web` are sub-selectors of the same kind, added for
// `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`'s lane x scenario
// matrix: every spec that drives the packaged Electron app carries `@surface-desktop`,
// every spec that drives a browser surface carries `@surface-web`, so a spec can be
// selected by WHICH SURFACE it exercises independent of which suite (core/live) or
// which other sub-selector (`@tier-real`, `@workgraph-real`) it also carries.
// Packaged-app specs are collected only when CLAXEDO_E2E_DESKTOP=1. This keeps
// browser lanes at zero skips while the desktop CI lane still executes every
// `desktop-*.spec.ts` test against the artifact it requires.
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
const screenshot = process.env.PLAYWRIGHT_SCREENSHOT === "1" ? "on" : "only-on-failure"
const workGraphReal = process.env.CLAXEDO_WORKGRAPH_REAL_E2E === "1"
const workGraphApiPort = Number(process.env.CLAXEDO_WORKGRAPH_E2E_API_PORT ?? 4311)
const liveBackendPort = Number(process.env.CLAXEDO_E2E_LIVE_BACKEND_PORT ?? 3001)
// Tier R (`real-*.spec.ts`, @tier-real): real claxedo-server + real harness
// binaries against a scripted model endpoint. It uses the same carve-out mechanics
// as @workgraph-real, but retains its own CI job and backend port baked into the app
// build — a shard cannot host it because a shard's build points at :3001.
const tierReal = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const tierRealBackendPort = Number(process.env.CLAXEDO_TIER_REAL_BACKEND_PORT ?? 4317)
// CI serves production output because cold on-demand dev transforms push first
// navigations past the expect timeouts. `build-preview` preserves the local and
// special-lane behavior of building before preview; `preview` consumes an exact
// artifact built once by CI and must never silently rebuild it in a shard.
const serveModes = ["dev", "build-preview", "preview"] as const
type ServeMode = (typeof serveModes)[number]
const serveMode = process.env.CLAXEDO_E2E_SERVE_MODE ?? "dev"
if (!serveModes.includes(serveMode as ServeMode)) {
  throw new Error(`CLAXEDO_E2E_SERVE_MODE="${serveMode}" is not known. Known modes: ${serveModes.join(", ")}.`)
}
const prebuilt = serveMode !== "dev"
const webServer =
  process.env.PLAYWRIGHT_SKIP_WEBSERVER === "1"
    ? undefined
    : {
        command: `${workGraphReal ? `bun --cwd ../workgraph run build && ` : ""}${workGraphReal ? `VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:${workGraphApiPort} ` : ""}${tierReal ? `VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:${tierRealBackendPort} ` : suite === "live" ? `VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:${liveBackendPort} ` : ""}bun run serve:e2e -- ${serveMode} ${port}`,
        url: baseURL,
        reuseExistingServer: reuse,
        timeout: prebuilt ? 600_000 : 120_000,
      }

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: [
    "**/deployed-workgraph.spec.ts",
    ...(process.env.CLAXEDO_E2E_DESKTOP === "1" ? [] : ["**/desktop-*.spec.ts", "**/real-desktop-*.spec.ts"]),
  ],
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
    screenshot,
    video,
  },
  projects: [
    {
      name: "chromium",
      // Mobile smoke specs opt into the `mobile` project below (`--project=mobile`);
      // they must never also run at desktop viewport as part of the default/@core
      // suite here.
      testIgnore: [
        "**/mobile-*.spec.ts",
        "**/deployed-workgraph.spec.ts",
        ...(process.env.CLAXEDO_E2E_DESKTOP === "1" ? [] : ["**/desktop-*.spec.ts", "**/real-desktop-*.spec.ts"]),
      ],
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
