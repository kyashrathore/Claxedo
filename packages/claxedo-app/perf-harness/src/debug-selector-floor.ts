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

// The hooks this lane converted from an attribute bucket to a class bucket.
const CONVERTED: Array<[string, string]> = [
  ["data-component", "button-v2"], ["data-component", "icon"], ["data-slot", "icon-svg"],
  ["data-component", "icon-button-v2"], ["data-slot", "tabs-list"], ["data-slot", "project-avatar-surface"],
  ["data-slot", "tabs-trigger"], ["data-slot", "switch-control"], ["data-component", "dialog-overlay"],
  ["data-slot", "accordion-trigger"], ["data-slot", "tabs-v2-trigger-wrapper"], ["data-component", "icon-button"],
  ["data-component", "select-v2"], ["data-slot", "dialog-container"], ["data-slot", "tabs-trigger-wrapper"],
  ["data-slot", "diff-changes-additions"], ["data-slot", "diff-changes-deletions"], ["data-slot", "accordion-content"],
  ["data-slot", "checkbox-checkbox-control"], ["data-slot", "collapsible-arrow"], ["data-slot", "tabs-v2-list"],
  ["data-component", "button"], ["data-component", "avatar-v2"],
]

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

const parity = await page.evaluate((converted) => {
  const rows: Array<{ hook: string; withAttribute: number; withClass: number }> = []
  for (const [attribute, value] of converted) {
    const token = `ui-${value}`
    const withAttribute = document.querySelectorAll(`[${attribute}="${CSS.escape(value)}"]`).length
    const withClass = document.querySelectorAll(`[${attribute}="${CSS.escape(value)}"].${CSS.escape(token)}`).length
    if (withAttribute > 0) rows.push({ hook: `${attribute}=${value}`, withAttribute, withClass })
  }
  return rows
}, CONVERTED)

console.log(`\n[${LABEL}] floor min=${round(measured.min)}ms p25=${round(measured.p25)}ms median=${round(measured.median)}ms`)
console.log(
  `[${LABEL}] elements=${measured.elements} (data-slot=${measured.dataSlot}, data-component=${measured.dataComponent})` +
    `  perElement=${round((measured.min * 1000) / measured.elements)}µs`,
)
console.log(`[${LABEL}] CSV,${LABEL},${round(measured.min)},${round(measured.p25)},${round(measured.median)},${measured.elements}`)

console.log(`\n[${LABEL}] class parity for converted hooks present on this page:`)
let broken = 0
for (const row of parity) {
  const ok = row.withClass === row.withAttribute
  if (!ok) broken++
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${row.hook.padEnd(42)} attribute=${String(row.withAttribute).padStart(4)}` +
      ` class=${String(row.withClass).padStart(4)}`,
  )
}
console.log(broken === 0 ? `[${LABEL}] class parity: OK` : `[${LABEL}] class parity: ${broken} BROKEN HOOKS`)

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
