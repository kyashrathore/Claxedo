// TEMP probe (read-only diagnosis): reproduce the same-workspace session
// switch with the workspace panel CLOSED and attribute every vcs-class /
// workspace-class request to the JS stack that issued it, alongside the
// TanStack cache freshness of the runtime.* entries at the moment of the
// switch. Answers stability gate (a) of session-switch-workspace.
//
// Run:
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=46087 \
//     bun src/debug-session-switch-requests.ts
import { chromium } from "@playwright/test"
import {
  fixtureFor,
  installMockApi,
  installSeedState,
  launchTo,
  monitorPage,
  sessionPath,
  startApp,
  stopApp,
  waitForTranscript,
} from "./browser-runner"
import { environmentProfile } from "./environment-profile"
import { seedForScenario } from "./seed"
import { stabilityRequestClass } from "./session-switch-workspace-contract"

type ProbeEntry = { url: string; t: number; stack: string }

const scenario = "session-switch-workspace" as const
const app = await startApp()
const fixture = fixtureFor(scenario, seedForScenario(scenario))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 400)))

await page.addInitScript(() => {
  const w = window as unknown as { __probeReq?: unknown[] }
  w.__probeReq = []
  const original = window.fetch
  window.fetch = function patched(this: unknown, ...args: Parameters<typeof fetch>) {
    const input = args[0]
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url
    w.__probeReq!.push({ url, t: performance.now(), stack: new Error("probe").stack ?? "" })
    return original.apply(this as never, args)
  } as typeof fetch
})

await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)

const home = fixture.sessions[0]!
const sameWorkspaceCold = fixture.sessions[2]!
console.log("home dir", home.directory, "| cold target dir", sameWorkspaceCold.directory)

await launchTo(page, app, sessionPath(fixture, home.id))
await waitForTranscript(page, fixture, home.id, home.title)
await page.waitForTimeout(1500)

const runtimeCache = async (label: string) =>
  console.log(
    label,
    JSON.stringify(
      await page.evaluate(() => {
        const client = (window as unknown as { __claxedoQueryClient?: any }).__claxedoQueryClient
        if (!client) return [{ key: "(no query client)" }]
        const now = Date.now()
        return client
          .getQueryCache()
          .getAll()
          .filter((query: any) => query.queryKey[0] === "runtime")
          .map((query: any) => ({
            key: query.queryKey,
            ageMs: query.state.dataUpdatedAt ? now - query.state.dataUpdatedAt : undefined,
            status: query.state.status,
            fetchStatus: query.state.fetchStatus,
            observers: query.getObserversCount(),
          }))
      }),
      null,
      1,
    ),
  )

const probeSince = async (mark: number) =>
  await page.evaluate((from) => {
    const all = ((window as unknown as { __probeReq?: ProbeEntry[] }).__probeReq ?? []) as ProbeEntry[]
    return all.slice(from)
  }, mark)

const markProbe = async () => await page.evaluate(() => ((window as unknown as { __probeReq?: unknown[] }).__probeReq ?? []).length)

const activate = (sessionId: string) => {
  const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${sessionId}"]`).first()
  return row.locator('[data-slot="navigation-row-activate"]').first()
}

const switchTo = async (label: string, sessionId: string) => {
  console.log(`\n================ ${label} (${sessionId}) ================`)
  await runtimeCache(`[${label}] runtime cache BEFORE:`)
  const mark = await markProbe()
  const bootMs = await page.evaluate(() => performance.now())
  console.log(`[${label}] click at page t=${Math.round(bootMs)}ms`)
  const control = activate(sessionId)
  await control.scrollIntoViewIfNeeded().catch(() => undefined)
  await control.click()
  await page.waitForTimeout(2500)
  const entries = await probeSince(mark)
  const interesting = entries.filter((entry) => {
    const cls = stabilityRequestClass(new URL(entry.url, "http://x").pathname)
    return cls === "vcs" || cls === "workspace"
  })
  console.log(`[${label}] total requests during switch: ${entries.length}; vcs/workspace: ${interesting.length}`)
  for (const entry of entries) {
    const cls = stabilityRequestClass(new URL(entry.url, "http://x").pathname)
    if (cls) console.log(`  [${cls}] ${new URL(entry.url, "http://x").pathname}${new URL(entry.url, "http://x").search}`)
  }
  for (const entry of interesting) {
    console.log(`\n--- STACK for ${entry.url}`)
    console.log(entry.stack.split("\n").slice(0, 14).join("\n"))
  }
  await runtimeCache(`[${label}] runtime cache AFTER:`)
}

await switchTo("closed_within_cold", sameWorkspaceCold.id)
await switchTo("closed_within_warm", home.id)

// Same cold switch again after the 15s freshness window has certainly lapsed,
// to separate "stale refetch" from "cache key miss".
console.log("\n>>> idling 16s so every 15s-staleTime runtime entry is stale <<<")
await page.waitForTimeout(16_000)
await switchTo("closed_within_cold_after_idle", fixture.sessions[4]!.id)

// Whole-run history of every vcs/workspace-class request with its stack, so
// the owners (and their cadence) are attributable end to end.
const history = await probeSince(0)
console.log("\n================ ALL vcs/workspace requests this run ================")
for (const entry of history) {
  const parsed = new URL(entry.url, "http://x")
  const cls = stabilityRequestClass(parsed.pathname)
  if (cls !== "vcs" && cls !== "workspace") continue
  console.log(`\n[${cls}] t=${Math.round(entry.t)}ms ${parsed.pathname}${parsed.search}`)
  console.log(entry.stack.split("\n").slice(1, 10).join("\n"))
}

// Ownership proof: the vcs-query observers belong to the panel-CLOSED session
// environment cards. Opening the workspace panel flips their `visible()` to
// false, which must drop the observer count to zero; closing restores it.
const vcsObservers = async () =>
  await page.evaluate(() => {
    const client = (window as unknown as { __claxedoQueryClient?: any }).__claxedoQueryClient
    const query = client
      ?.getQueryCache()
      .getAll()
      .find((entry: any) => entry.queryKey[0] === "runtime" && entry.queryKey[2] === "vcs")
    return {
      observers: query?.getObserversCount() ?? -1,
      envCards: document.querySelectorAll(".session-envcard-shell > *").length,
      panes: document.querySelectorAll("[data-testid='session-page-root']").length,
    }
  })
console.log("\nvcs observers, panel CLOSED:", JSON.stringify(await vcsObservers()))
await page.locator("[data-testid='workspace-panel-toggle']").first().click()
await page.waitForTimeout(2500)
console.log("vcs observers, panel OPEN:  ", JSON.stringify(await vcsObservers()))
await page.locator("[data-testid='workspace-panel-toggle']").first().click()
await page.waitForTimeout(2500)
console.log("vcs observers, panel CLOSED:", JSON.stringify(await vcsObservers()))

await browser.close()
await stopApp(app)
