// Probe (read-only diagnosis): a census of the rail's background status triple.
//
// The rail renders "working"/"permission" badges from a batch of three
// directory-wide reads — `/session/status`, `/permission`, `/question`. This
// probe boots the app, idles, and prints:
//   - TRIPLE CENSUS   every request to those three endpoints with its page
//                     clock, grouped into batches by arrival time, so the
//                     *schedule* is observed rather than inferred from the
//                     poll's configured interval
//   - RAIL DEBUG      the app's own `claxedo.debug.sidebar-requests` channel,
//                     which names why each batch went out (`fetch-group` /
//                     `skip-fresh` / `skip-in-flight`) and prints
//                     `target-groups` whenever the rail's row set changes
//   - BOOT HYDRATION  `/api/claxedo/workspace/resolve` and `/vcs`, the pair the
//                     stale-refetch lane attributed to bootstrap's postPaint
//                     warm-up, on the same clock
//
// Two owners issue the triple -- the rail's batch and the session pane's meta
// hydration -- and only the rail logs itself. They are told apart by TIMING
// against the rail's debug lines, not by JS stacks: both funnel through one
// shared SDK client, so a stack recorder returns the same frames for each.
//
// Reading it: a `fetch-group` that follows a `target-groups` line is a batch
// re-issued because the rail's membership changed, NOT because the previous
// response aged out. Those are the ones that keep the triple ticking for
// seconds after boot.
//
// Run (about 40s with a prebuilt dist):
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 bun src/debug-rail-poll-probe.ts
//
// The probe never touches application source; it only drives the built app.
import { chromium } from "@playwright/test"
process.env.CLAXEDO_PERF_CAUSAL ??= "1"

import { frameSamplingLaunchArgs } from "./frame-sampler"
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

const SCENARIO = (process.env.RAIL_PROBE_SCENARIO ?? "workspace-lifecycle") as
  | "workspace-lifecycle"
  | "session-switch-workspace"
const OBSERVE_MS = Number(process.env.RAIL_PROBE_OBSERVE_MS ?? "12000")

const TRIPLE = ["/session/status", "/permission", "/question"]
const HYDRATION = ["/api/claxedo/workspace/resolve", "/vcs"]

const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.on("pageerror", (error) => console.log("[pageerror]", (error.stack ?? String(error)).slice(0, 800)))

await page.addInitScript(() => {
  try {
    localStorage.setItem("claxedo.debug.sidebar-requests", "1")
  } catch {}
  performance.setResourceTimingBufferSize?.(4_000)
})

const railLines: Array<{ atMs: number; text: string }> = []
page.on("console", (message) => {
  const text = message.text()
  if (!text.includes("claxedo:sidebar-requests")) return
  railLines.push({ atMs: Date.now(), text: text.slice(0, 500) })
})

await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)

const session = fixture.sessions[0]!
console.log(`[probe] scenario=${SCENARIO} observe=${OBSERVE_MS}ms`)
await launchTo(page, app, sessionPath(session, session.id))
await waitForTranscript(page, fixture, session.id, session.title)
const readyAt = await page.evaluate(() => performance.now())
console.log(`[probe] transcript ready at page-clock ${Math.round(readyAt)}ms`)

// Idle and let the background rail poll run untouched — no interaction at all,
// so every request printed below is background traffic by construction.
await page.waitForTimeout(OBSERVE_MS)

const census = await page.evaluate(({ triple, hydration }) => {
  return performance
    .getEntriesByType("resource")
    .filter((entry) => !entry.name.startsWith("data:"))
    .map((entry) => {
      const path = entry.name.replace(/^https?:\/\/[^/]+/, "")
      const bare = path.split("?")[0] ?? path
      return { path, bare, startMs: Math.round(entry.startTime), durationMs: Math.round(entry.duration) }
    })
    .filter((entry) =>
      triple.some((suffix) => entry.bare.endsWith(suffix)) ||
      hydration.some((suffix) => entry.bare.endsWith(suffix)))
    .sort((a, b) => a.startMs - b.startMs)
}, { triple: TRIPLE, hydration: HYDRATION })

const tripleEntries = census.filter((entry) => TRIPLE.some((suffix) => entry.bare.endsWith(suffix)))
const hydrationEntries = census.filter((entry) => HYDRATION.some((suffix) => entry.bare.endsWith(suffix)))

// Group the triple into batches: requests fired together by one `run` land
// within a few ms of one another, so a gap larger than BATCH_GAP_MS starts a
// new batch. This turns the raw list into the schedule actually observed.
const BATCH_GAP_MS = 40
const batches: Array<{ atMs: number; paths: string[] }> = []
for (const entry of tripleEntries) {
  const last = batches.at(-1)
  if (last && entry.startMs - last.atMs <= BATCH_GAP_MS) last.paths.push(entry.bare)
  else batches.push({ atMs: entry.startMs, paths: [entry.bare] })
}

console.log(`\n=== TRIPLE CENSUS  (${tripleEntries.length} requests in ${batches.length} batches over ${Math.round(OBSERVE_MS / 1000)}s of idle)`)
let previousAt = 0
for (const [index, batch] of batches.entries()) {
  const gap = index === 0 ? batch.atMs : batch.atMs - previousAt
  previousAt = batch.atMs
  const relToReady = batch.atMs - Math.round(readyAt)
  console.log(
    `  batch ${String(index + 1).padStart(2)}  page+${String(batch.atMs).padStart(6)}ms  ready${relToReady >= 0 ? "+" : ""}${String(relToReady).padStart(6)}ms  gap ${String(gap).padStart(5)}ms  n=${batch.paths.length}  ${[...new Set(batch.paths)].join(" ")}`,
  )
}
if (batches.length === 0) console.log("  (none)")

console.log(`\n=== BOOT HYDRATION CENSUS (resolve + vcs)`)
for (const entry of hydrationEntries) {
  console.log(`  page+${String(entry.startMs).padStart(6)}ms  ${String(entry.durationMs).padStart(4)}ms  ${entry.path.slice(0, 140)}`)
}
if (hydrationEntries.length === 0) console.log("  (none)")

console.log(`\n=== RAIL DEBUG LINES (${railLines.length})`)
const firstLineAt = railLines[0]?.atMs ?? 0
for (const line of railLines) {
  console.log(`  +${String(line.atMs - firstLineAt).padStart(6)}ms  ${line.text}`)
}
if (railLines.length === 0) console.log("  (none)")

const fetchGroups = railLines.filter((line) => line.text.includes("fetch-group")).length
const skipFresh = railLines.filter((line) => line.text.includes("skip-fresh")).length
const targetGroups = railLines.filter((line) => line.text.includes("target-groups")).length
console.log(`\n=== SUMMARY`)
console.log(`  triple requests          ${tripleEntries.length}`)
console.log(`  triple batches           ${batches.length}`)
console.log(`  rail target-groups lines ${targetGroups}   (row-set changes: each mints a fresh batch key)`)
console.log(`  rail fetch-group lines   ${fetchGroups}`)
console.log(`  rail skip-fresh lines    ${skipFresh}`)
console.log(`  last triple batch at     page+${batches.at(-1)?.atMs ?? 0}ms`)

await browser.close()
await stopApp(app)
