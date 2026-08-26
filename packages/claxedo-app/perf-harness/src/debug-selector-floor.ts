// TEMP probe (read-only measurement): the whole-document style pass on a settled
// workbench, for A/B-ing two builds of the app.
//
// Same meter as `debug-style-floor-attribution.ts`: write a custom property on
// <html> to dirty every element, then read one computed colour to flush style
// alone (no layout). The reported number is the MIN of N samples, which is the
// drift-resistant statistic on a shared box — a loaded machine can only ever make
// a sample slower, never faster, so the floor of the distribution is the honest
// estimate of the work the engine actually has to do.
//
// It also asserts CLASS PARITY: for every attribute hook this lane converted to a
// class, every element still carrying the attribute must also carry the class. A
// converted selector whose element lost its class is a silent visual regression,
// so the probe fails loudly rather than reporting a fast-but-wrong build.
//
// Run:
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked> bun src/debug-selector-floor.ts
import { chromium } from "@playwright/test"

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
const SAMPLES = Number(process.env.PROBE_SAMPLES ?? 15)
const LABEL = process.env.PROBE_LABEL ?? "run"
const SHOT_DIR = process.env.PROBE_SHOT_DIR ?? "/tmp/claxedo-selector-floor"

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

const measured = await page.evaluate((samples) => {
  const values: number[] = []
  for (let index = 0; index < samples; index++) {
    document.documentElement.style.setProperty("--claxedo-floor-probe", String(index))
    const started = performance.now()
    void getComputedStyle(document.body).color
    values.push(performance.now() - started)
  }
  document.documentElement.style.removeProperty("--claxedo-floor-probe")
  void getComputedStyle(document.body).color
  values.sort((a, b) => a - b)
  return {
    min: values[0]!,
    p25: values[Math.floor(values.length * 0.25)]!,
    median: values[Math.floor(values.length / 2)]!,
    elements: document.querySelectorAll("*").length,
    dataSlot: document.querySelectorAll("[data-slot]").length,
    dataComponent: document.querySelectorAll("[data-component]").length,
  }
}, SAMPLES)

// The converted-hook list is DERIVED from the shipped stylesheet rather than kept
// by hand: every `.ui-x` class the built CSS styles is a hook whose rule used to
// be `[data-slot=x]` / `[data-component=x]`. Reading it from the authoritative
// producer means the assertion cannot drift behind a later conversion lane.
// PROBE_PARITY_SELFTEST=1 strips the class off one converted element before the
// scan. A build where every hook is intact cannot tell a working assertion from a
// vacuous one, so this is how the assertion is shown to still bite.
const parity = await page.evaluate((selftest) => {
  const tokens = new Set<string>()
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const grouped = (rule as CSSGroupingRule).cssRules
      if (grouped) walk(grouped)
      const selector = (rule as CSSStyleRule).selectorText
      if (!selector) continue
      for (const match of selector.matchAll(/\.(ui-[\w-]+)/g)) tokens.add(match[1]!)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules)
    } catch {
      // cross-origin sheet: nothing this page can read, and nothing this app ships
    }
  }
  if (selftest) {
    for (const token of tokens) {
      const victim = document.querySelector(`.${CSS.escape(token)}`)
      if (!victim) continue
      victim.classList.remove(token)
      break
    }
  }
  const rows: Array<{ hook: string; withAttribute: number; withClass: number }> = []
  for (const token of tokens) {
    const value = token.slice("ui-".length)
    for (const attribute of ["data-slot", "data-component"]) {
      const withAttribute = document.querySelectorAll(`[${attribute}="${CSS.escape(value)}"]`).length
      if (withAttribute === 0) continue
      const withClass = document.querySelectorAll(
        `[${attribute}="${CSS.escape(value)}"].${CSS.escape(token)}`,
      ).length
      rows.push({ hook: `${attribute}=${value}`, withAttribute, withClass })
    }
  }
  rows.sort((left, right) => left.hook.localeCompare(right.hook))
  return rows
}, process.env.PROBE_PARITY_SELFTEST === "1")

console.log(`\n[${LABEL}] floor min=${round(measured.min)}ms p25=${round(measured.p25)}ms median=${round(measured.median)}ms`)
console.log(
  `[${LABEL}] elements=${measured.elements} (data-slot=${measured.dataSlot}, data-component=${measured.dataComponent})` +
    `  perElement=${round((measured.min * 1000) / measured.elements)}µs`,
)
console.log(`[${LABEL}] CSV,${LABEL},${round(measured.min)},${round(measured.p25)},${round(measured.median)},${measured.elements}`)

console.log(`\n[${LABEL}] class parity: ${parity.length} converted hooks present on this page`)
const brokenRows = parity.filter((row) => row.withClass !== row.withAttribute)
for (const row of brokenRows) {
  console.log(
    `  FAIL ${row.hook.padEnd(46)} attribute=${String(row.withAttribute).padStart(4)}` +
      ` class=${String(row.withClass).padStart(4)}`,
  )
}
console.log(
  brokenRows.length === 0
    ? `[${LABEL}] class parity: OK`
    : `[${LABEL}] class parity: ${brokenRows.length} BROKEN HOOKS`,
)

if (process.env.PROBE_SHOTS === "1") {
  await page.screenshot({ path: `${SHOT_DIR}/${LABEL}-1440x960.png` })
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/${LABEL}-1024x768.png` })
  console.log(`[${LABEL}] screenshots written to ${SHOT_DIR}`)
}

await browser.close()
await stopApp(app)
process.exit(0)
