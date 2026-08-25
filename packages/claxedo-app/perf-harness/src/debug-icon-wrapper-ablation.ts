// TEMP probe (read-only diagnosis): what the icon primitive's wrapper element
// costs one whole-document style recalculation.
//
// Every icon renders as `div[data-component=icon] > svg[data-slot=icon-svg] >
// use` — three elements per glyph. This probe boots the same settled page the
// other floor probes use and then, IN PLACE, removes only the wrapper div:
// each `div[data-component=icon]` is replaced by its own `<svg>` child, and the
// wrapper's attributes (data-component / data-icon / data-library / data-size)
// are carried onto that svg so the selector surface the matcher sees is
// unchanged. The ONLY difference between the two halves of a pair is one
// element per icon.
//
// PAIRED and INTERLEAVED, for the reason spelled out in
// debug-style-floor-attribution.ts: ~105 icons against a ~1900-element document
// is a 1-3ms effect, which is smaller than this machine's drift across a probe
// run. Each round therefore re-measures the floor wrapped and unwrapped back to
// back and reports the MEDIAN paired difference, so drift that moves both
// halves cancels instead of accumulating.
//
// It mutates the live page's DOM, so it is a measurement tool only: the page is
// thrown away afterwards.
//
// Run:
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked> bun src/debug-icon-wrapper-ablation.ts
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
const ROUNDS = Number(process.env.PROBE_ROUNDS) || 25
const round = (value: number) => Math.round(value * 100) / 100

const installMeter = async (page: Page) =>
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    w.__floor = {
      time: (samples = 7) => {
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
        return { min: values[0]!, median: values[Math.floor(values.length / 2)]! }
      },
      count: () => {
        let total = document.querySelectorAll("*").length
        for (const host of document.querySelectorAll("*")) {
          const shadow = (host as HTMLElement).shadowRoot
          if (shadow) total += shadow.querySelectorAll("*").length
        }
        return total
      },
    }
  })

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
await installMeter(page)

const shape = await page.evaluate(() => ({
  total: document.querySelectorAll("*").length,
  wrappers: document.querySelectorAll("div[data-component='icon']").length,
  flat: document.querySelectorAll("svg[data-component='icon']").length,
  svgs: document.querySelectorAll("[data-slot='icon-svg']").length,
  uses: document.querySelectorAll("[data-slot='icon-svg'] use").length,
}))
console.log("\n=== icon element mass in the settled workspace document ===")
console.log(`  document elements                ${shape.total}`)
console.log(`  div[data-component=icon] wrappers ${shape.wrappers}`)
console.log(`  svg[data-component=icon] (flat)   ${shape.flat}`)
console.log(`  [data-slot=icon-svg] svgs         ${shape.svgs}`)
console.log(`  <use> inside those svgs           ${shape.uses}`)
console.log(`  icon share of the document        ${round(((shape.svgs + shape.uses + shape.wrappers) * 100) / shape.total)}%`)

if (shape.wrappers === 0) {
  console.log("\n  no wrapper divs present — this build already renders the flat icon primitive.")
  console.log("  measuring the floor once for the record:")
  const measured = await page.evaluate(() => {
    const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
    return { ...w.__floor.time(), elements: w.__floor.count() }
  })
  console.log(`  floor min=${round(measured.min)}ms median=${round(measured.median)}ms els=${measured.elements}` +
    ` perEl=${round((measured.min * 1000) / Math.max(1, measured.elements))}µs`)
} else {
  console.log(`\n=== paired ablation: wrapper present vs wrapper removed (${ROUNDS} interleaved rounds) ===`)
  const measured = await page.evaluate(async (rounds) => {
    const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
    // Carry the wrapper's own attributes onto the svg while unwrapped so the
    // selector surface is identical in both halves and only the element count
    // moves.
    const CARRIED = ["data-component", "data-icon", "data-library", "data-size"]
    const records = Array.from(document.querySelectorAll<HTMLElement>("div[data-component='icon']"))
      .map((div) => {
        const svg = div.firstElementChild as SVGElement | null
        return {
          div,
          svg,
          carried: CARRIED.map((name) => [name, div.getAttribute(name)] as const),
          original: CARRIED.map((name) => [name, svg?.getAttribute(name) ?? null] as const),
        }
      })
      .filter((record) => record.svg !== null)

    const unwrap = () => {
      for (const record of records) {
        const svg = record.svg!
        for (const [name, value] of record.carried) if (value !== null) svg.setAttribute(name, value)
        record.div.replaceWith(svg)
      }
    }
    const rewrap = () => {
      for (const record of records) {
        const svg = record.svg!
        // Idempotent: a round may start already wrapped.
        if (svg.parentNode === record.div) continue
        for (const [name, value] of record.original) {
          if (value === null) svg.removeAttribute(name)
          else svg.setAttribute(name, value)
        }
        svg.replaceWith(record.div)
        record.div.append(svg)
      }
    }

    const deltas: number[] = []
    let wrappedElements = 0
    let flatElements = 0
    for (let index = 0; index < rounds; index++) {
      rewrap()
      const wrapped = w.__floor.time(5).min
      wrappedElements = w.__floor.count()
      unwrap()
      const flat = w.__floor.time(5).min
      flatElements = w.__floor.count()
      deltas.push(wrapped - flat)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    rewrap()
    void getComputedStyle(document.body).color
    deltas.sort((a, b) => a - b)
    return {
      saved: deltas[Math.floor(deltas.length / 2)]!,
      low: deltas[0]!,
      high: deltas[deltas.length - 1]!,
      deltas,
      wrappedElements,
      flatElements,
      wrappers: records.length,
    }
  }, ROUNDS)

  const removed = measured.wrappedElements - measured.flatElements
  console.log(`  wrappers removed per pass         ${measured.wrappers}`)
  console.log(`  document elements  wrapped=${measured.wrappedElements}  flat=${measured.flatElements}  (-${removed})`)
  console.log(`  median paired saving              ${round(measured.saved)}ms` +
    `  [${round(measured.low)}..${round(measured.high)} over ${ROUNDS} pairs]`)
  console.log(`  per removed element               ${round((measured.saved * 1000) / Math.max(1, removed))}µs`)
  console.log(`  every paired delta (ms)           ${measured.deltas.map((value) => round(value)).join(", ")}`)
}

// The in-place ablation moves ~100 elements against a ~1800-element document,
// which is inside this machine's own drift. To get a per-element number that is
// ABOVE the noise, synthesize the same two shapes at 10x the scale and take the
// paired difference there: same sprite references, same attributes, same
// ancestors, differing only by the wrapper element.
console.log(`\n=== synthetic scale-up: ${1000} icons, wrapped vs flat (${ROUNDS} interleaved rounds) ===`)
const synthetic = await page.evaluate(async ({ rounds, count }) => {
  const w = window as unknown as { __floor: { time: (n?: number) => { min: number; median: number }; count: () => number } }
  const template = document.querySelector<HTMLElement>("div[data-component='icon']")
  if (!template) return undefined
  const svgTemplate = template.firstElementChild as SVGElement
  const host = document.createElement("div")
  host.style.position = "absolute"
  host.style.top = "-100000px"
  document.body.append(host)

  const fill = (wrapped: boolean) => {
    host.replaceChildren()
    for (let index = 0; index < count; index++) {
      const svg = svgTemplate.cloneNode(true) as SVGElement
      if (wrapped) {
        const div = template.cloneNode(false) as HTMLElement
        div.append(svg)
        host.append(div)
      } else {
        for (const name of ["data-component", "data-icon", "data-library", "data-size"]) {
          const value = template.getAttribute(name)
          if (value !== null) svg.setAttribute(name, value)
        }
        host.append(svg)
      }
    }
  }

  const deltas: number[] = []
  let wrappedElements = 0
  let flatElements = 0
  for (let index = 0; index < rounds; index++) {
    fill(true)
    const wrapped = w.__floor.time(5).min
    wrappedElements = w.__floor.count()
    fill(false)
    const flat = w.__floor.time(5).min
    flatElements = w.__floor.count()
    deltas.push(wrapped - flat)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  host.remove()
  void getComputedStyle(document.body).color
  deltas.sort((a, b) => a - b)
  return {
    saved: deltas[Math.floor(deltas.length / 2)]!,
    low: deltas[0]!,
    high: deltas[deltas.length - 1]!,
    wrappedElements,
    flatElements,
  }
}, { rounds: ROUNDS, count: 1000 })

if (synthetic) {
  const removed = synthetic.wrappedElements - synthetic.flatElements
  console.log(`  document elements  wrapped=${synthetic.wrappedElements}  flat=${synthetic.flatElements}  (-${removed})`)
  console.log(`  median paired saving              ${round(synthetic.saved)}ms` +
    `  [${round(synthetic.low)}..${round(synthetic.high)} over ${ROUNDS} pairs]`)
  console.log(`  per removed wrapper element       ${round((synthetic.saved * 1000) / Math.max(1, removed))}µs`)
  console.log(`  extrapolated to the real ${shape.wrappers} icons  ` +
    `${round((synthetic.saved * shape.wrappers) / Math.max(1, removed))}ms`)
}

await browser.close()
await stopApp(app)
