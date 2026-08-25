// TEMP probe (read-only diagnosis): WHICH SELECTORS does one whole-document
// style recalculation spend its time matching?
//
// `debug-style-floor-attribution.ts` proved the floor is selector MATCHING, not
// declaration APPLYING (emptying every declaration in the main sheet moved the
// floor by ~0). It could not say which selectors. Blink can: with the
// `disabled-by-default-blink.debug` trace category armed, every style recalc
// emits a `SelectorStats` trace event listing each selector it tried, how long
// it spent there, how many elements it was attempted against, and how many of
// those were rejected by the fast-reject bloom filter.
//
// This probe boots the same settled page, arms that category, forces exactly the
// same whole-document invalidation the floor meter uses, and aggregates the
// resulting per-selector timings. The output is an attribution table: selector
// -> total µs -> match attempts -> fast rejects.
//
// Run:
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked> bun src/debug-selector-stats.ts
import { chromium, type Page } from "@playwright/test"

import { frameSamplingLaunchArgs } from "./frame-sampler"
import {
  fixtureFor,
  installMockApi,
  installSeedState,
  launchTo,
  monitorPage,
  openReviewSurface,
  sessionPath,
  startApp,
  stopApp,
  waitForTranscript,
} from "./browser-runner"
import { environmentProfile } from "./environment-profile"
import { settleBeforeNextInteraction } from "./isolated-interaction"
import { seedForScenario } from "./seed"

const SCENARIO = "workspace-interactions" as const
const round = (value: number) => Math.round(value * 100) / 100
const RECALCS = Number(process.env.PROBE_RECALCS ?? 12)

const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 300)))

await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)
const session = fixture.sessions[0]!
await launchTo(page, app, sessionPath(session, session.id))
await waitForTranscript(page, fixture, session.id, session.title)
await openReviewSurface(page, fixture, { settle: "frame" })
await settleBeforeNextInteraction(page)

const census = await page.evaluate(() => ({
  total: document.querySelectorAll("*").length,
  classed: document.querySelectorAll("[class]").length,
  dataSlot: document.querySelectorAll("[data-slot]").length,
  dataComponent: document.querySelectorAll("[data-component]").length,
}))
console.log(
  `document: ${census.total} elements — ${census.classed} with class,` +
    ` ${census.dataSlot} with data-slot, ${census.dataComponent} with data-component`,
)

// --- arm the trace -----------------------------------------------------------
const client = await page.context().newCDPSession(page)
const events: Array<Record<string, unknown>> = []
client.on("Tracing.dataCollected", (payload: { value: Array<Record<string, unknown>> }) => {
  for (const event of payload.value) events.push(event)
})
const tracingComplete = new Promise<void>((resolve) => client.once("Tracing.tracingComplete", () => resolve()))

await client.send("Tracing.start", {
  transferMode: "ReportEvents",
  traceConfig: {
    recordMode: "recordAsMuchAsPossible",
    includedCategories: ["disabled-by-default-blink.debug", "blink", "blink.user_timing", "devtools.timeline"],
  },
})

// --- force exactly the floor meter's whole-document invalidation --------------
const timings = await page.evaluate((recalcs) => {
  const values: number[] = []
  for (let index = 0; index < recalcs; index++) {
    document.documentElement.style.setProperty("--claxedo-selstat-probe", String(index))
    const started = performance.now()
    void getComputedStyle(document.body).color
    values.push(performance.now() - started)
  }
  document.documentElement.style.removeProperty("--claxedo-selstat-probe")
  void getComputedStyle(document.body).color
  values.sort((a, b) => a - b)
  return { min: values[0]!, median: values[Math.floor(values.length / 2)]!, samples: values.length }
}, RECALCS)

await client.send("Tracing.end")
await tracingComplete

console.log(
  `\nforced ${timings.samples} whole-document recalcs: min=${round(timings.min)}ms median=${round(timings.median)}ms` +
    ` (${round((timings.min * 1000) / census.total)}µs/element at min)`,
)

// --- parse SelectorStats -----------------------------------------------------
const names = new Map<string, number>()
for (const event of events) {
  const name = String(event.name ?? "")
  names.set(name, (names.get(name) ?? 0) + 1)
}
console.log(`\ntrace events: ${events.length}`)
const selectorEvents = events.filter((event) => String(event.name ?? "").includes("SelectorStats"))
console.log(`SelectorStats events: ${selectorEvents.length}`)
if (selectorEvents.length === 0) {
  console.log("top trace event names seen:")
  for (const [name, count] of [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`  ${String(count).padStart(6)}  ${name}`)
  }
}

type Row = { elapsed: number; attempts: number; fastReject: number; matches: number; sheets: Set<string> }
const rows = new Map<string, Row>()
let totalElapsed = 0
for (const event of selectorEvents) {
  const args = event.args as Record<string, unknown> | undefined
  const stats = (args?.selector_stats ?? args?.selectorStats) as Record<string, unknown> | undefined
  const list = (stats?.selector_timings ?? stats?.selectorTimings) as Array<Record<string, unknown>> | undefined
  if (!list) continue
  for (const entry of list) {
    const selector = String(entry.selector ?? entry["selector_text"] ?? "?")
    const elapsed = Number(entry["elapsed (us)"] ?? entry.elapsed_us ?? entry.elapsed ?? 0)
    const attempts = Number(entry.match_attempts ?? entry["match_attempts"] ?? 0)
    const fastReject = Number(entry.fast_reject_count ?? 0)
    const matches = Number(entry.match_count ?? 0)
    const sheet = String(entry.style_sheet_id ?? "")
    let row = rows.get(selector)
    if (!row) {
      row = { elapsed: 0, attempts: 0, fastReject: 0, matches: 0, sheets: new Set() }
      rows.set(selector, row)
    }
    row.elapsed += elapsed
    row.attempts += attempts
    row.fastReject += fastReject
    row.matches += matches
    if (sheet) row.sheets.add(sheet)
    totalElapsed += elapsed
  }
}

console.log(`\ndistinct selectors timed: ${rows.size}   total ${round(totalElapsed)}µs over ${selectorEvents.length} recalc events`)
if (rows.size === 0) {
  await browser.close()
  await stopApp(app)
  process.exit(0)
}
const perRecalc = (value: number) => value / Math.max(1, RECALCS)

console.log("\n=== TOP 60 SELECTORS BY TOTAL MATCH TIME (per forced recalc) ===")
console.log(
  "µs/recalc".padStart(10) + "  " + "attempts".padStart(9) + "  " + "fastrej".padStart(8) + "  " + "match".padStart(6) + "  selector",
)
const ranked = [...rows.entries()].sort((a, b) => b[1].elapsed - a[1].elapsed)
for (const [selector, row] of ranked.slice(0, 60)) {
  console.log(
    String(round(perRecalc(row.elapsed))).padStart(10) +
      "  " + String(Math.round(perRecalc(row.attempts))).padStart(9) +
      "  " + String(Math.round(perRecalc(row.fastReject))).padStart(8) +
      "  " + String(Math.round(perRecalc(row.matches))).padStart(6) +
      "  " + selector.slice(0, 150),
  )
}

// --- roll the same rows up into selector FAMILIES ----------------------------
// A single selector rarely owns the floor; a SHAPE does. Bucket by the shape of
// the rightmost compound, which is what decides which elements Blink even tries
// the rule against.
const rightmostShape = (selector: string): string => {
  const sel = selector.trim()
  let depth = 0
  let bracket = 0
  let cut = 0
  for (let index = 0; index < sel.length; index++) {
    const ch = sel[index]!
    if (ch === "(") depth++
    else if (ch === ")") depth--
    else if (ch === "[") bracket++
    else if (ch === "]") bracket--
    else if (depth === 0 && bracket === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~")) cut = index + 1
  }
  const rc = sel.slice(cut)
  const complex = cut > 0
  const label = (base: string) => `${base}${complex ? "   (with combinator)" : ""}`
  if (/^\*/.test(rc)) return label("UNIVERSAL *")
  if (/^:is\(|^:where\(/.test(rc)) return label("rightmost :is()/:where()")
  if (/^:has\(/.test(rc)) return label("rightmost :has()")
  if (/^:not\(/.test(rc)) return label("rightmost :not()")
  if (/^:/.test(rc)) return label("rightmost bare pseudo")
  if (/^#/.test(rc)) return label("#id")
  if (/^\./.test(rc)) return label(".class")
  if (/^\[/.test(rc)) {
    const name = /^\[([-\w]+)/.exec(rc)?.[1] ?? "?"
    return label(`[${name}]`)
  }
  const tag = /^([-\w]+)/.exec(rc)?.[1] ?? "?"
  const rest = rc.slice(tag.length)
  if (/^[.#[]/.test(rest)) return label("tag+qualifier")
  return label(`bare tag <${tag}>`)
}

const families = new Map<string, { elapsed: number; attempts: number; fastReject: number; selectors: number }>()
for (const [selector, row] of rows) {
  const key = rightmostShape(selector)
  let family = families.get(key)
  if (!family) {
    family = { elapsed: 0, attempts: 0, fastReject: 0, selectors: 0 }
    families.set(key, family)
  }
  family.elapsed += row.elapsed
  family.attempts += row.attempts
  family.fastReject += row.fastReject
  family.selectors += 1
}
console.log("\n=== SELECTOR FAMILIES (rightmost-compound shape) ===")
console.log(
  "µs/recalc".padStart(10) + "  " + "share".padStart(6) + "  " + "sels".padStart(5) + "  " + "attempts".padStart(9) + "  family",
)
for (const [key, family] of [...families.entries()].sort((a, b) => b[1].elapsed - a[1].elapsed)) {
  console.log(
    String(round(perRecalc(family.elapsed))).padStart(10) +
      "  " + String(round((family.elapsed / totalElapsed) * 100)).padStart(5) + "%" +
      "  " + String(family.selectors).padStart(5) +
      "  " + String(Math.round(perRecalc(family.attempts))).padStart(9) +
      "  " + key,
  )
}

// --- and by the LEFT context, which is what makes a cheap bucket expensive ----
console.log("\n=== TOP 30 BY ATTEMPTS (how many elements Blink even tried this against) ===")
for (const [selector, row] of [...rows.entries()].sort((a, b) => b[1].attempts - a[1].attempts).slice(0, 30)) {
  console.log(
    String(Math.round(perRecalc(row.attempts))).padStart(9) + " attempts  " +
      String(round(perRecalc(row.elapsed))).padStart(8) + "µs  fastrej=" +
      String(Math.round(perRecalc(row.fastReject))).padStart(6) + "  " + selector.slice(0, 130),
  )
}

await browser.close()
await stopApp(app)
process.exit(0)
