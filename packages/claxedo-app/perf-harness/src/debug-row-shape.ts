// TEMP probe (read-only diagnosis): the exact shape of ONE materialized Review
// row, and the per-mount cost of the pieces the row-thinning experiment is
// allowed to replace.
//
// Prints:
//   1. the document/theme attributes the review CSS branches on;
//   2. the outerHTML of one collapsed row plus its element census;
//   3. computed opacity/pointer-events of the row's summary and controls at
//      rest, which is what says whether a control is a hover-only affordance;
//   4. a live construction micro-benchmark: mounting/unmounting the SAME row
//      subtree N times through the app's own list (by toggling the review
//      window), so "what does a Kobalte Tooltip cost per row" is measured
//      rather than assumed.
//
// Run:
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked> bun src/debug-row-shape.ts
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

const shape = await page.evaluate(() => {
  const html = document.documentElement
  const row = document.querySelector<HTMLElement>("[data-review-rendered-files] [data-review-file]")
  if (!row) return undefined
  const summary = row.querySelector<HTMLElement>("[data-slot='session-review-row-summary']")
  const controls = row.querySelector<HTMLElement>("[data-slot='session-review-row-controls']")
  const copy = row.querySelector<HTMLElement>("[data-slot='session-review-copy-button']")
  const chevron = row.querySelector<HTMLElement>("[data-slot='session-review-diff-chevron']")
  const view = row.querySelector<HTMLElement>("[data-slot='session-review-view-button']")
  const style = (element: HTMLElement | null) =>
    element
      ? (({ opacity, pointerEvents, position, transition, display, width, height, padding }) => ({
          opacity,
          pointerEvents,
          position,
          transition,
          display,
          width,
          height,
          padding,
        }))(getComputedStyle(element))
      : null
  const tree: string[] = []
  const walk = (node: Element, depth: number) => {
    tree.push(
      `${"  ".repeat(depth)}${node.tagName.toLowerCase()}` +
        `${node.getAttribute("data-component") ? `{${node.getAttribute("data-component")}}` : ""}` +
        `${node.getAttribute("data-slot") ? `<${node.getAttribute("data-slot")}>` : ""}`,
    )
    for (const child of Array.from(node.children)) walk(child, depth + 1)
  }
  walk(row, 0)
  return {
    theme: html.getAttribute("data-theme"),
    colorScheme: html.getAttribute("data-color-scheme"),
    newLayout: document.body.hasAttribute("data-new-layout"),
    reviewClass: !!document.querySelector(".claxedo-workspace-review"),
    rowElements: 1 + row.querySelectorAll("*").length,
    tree,
    outer: row.outerHTML.slice(0, 2400),
    computed: {
      summary: style(summary),
      controls: style(controls),
      copy: style(copy),
      chevron: style(chevron),
      view: style(view),
    },
  }
})

if (!shape) {
  console.log("no review row found")
} else {
  console.log(
    `theme=${shape.theme} colorScheme=${shape.colorScheme} newLayout=${shape.newLayout}` +
      ` reviewClass=${shape.reviewClass} rowElements=${shape.rowElements}`,
  )
  console.log("\n-- row tree --")
  for (const line of shape.tree) console.log(`  ${line}`)
  console.log("\n-- computed at rest --")
  for (const [name, value] of Object.entries(shape.computed)) {
    console.log(`  ${name.padEnd(10)} ${value ? JSON.stringify(value) : "(absent)"}`)
  }
  console.log("\n-- outerHTML (truncated) --")
  console.log(shape.outer)
}

// Construction cost of the row list: scroll the window far away and back, which
// disposes and rebuilds a full window of rows through the app's own code path.
// The rebuild is what a Files->Review switch and a panel reopen pay.
const rebuild = await page.evaluate(async () => {
  const scroller = document.querySelector<HTMLElement>("[data-review-rendered-files]")?.closest<HTMLElement>(
    "[data-slot='session-review-scroll'], .scroll-view__viewport",
  ) ?? document.scrollingElement as HTMLElement
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const rows = () => document.querySelectorAll("[data-review-rendered-files] [data-review-file]").length
  const samples: number[] = []
  for (let index = 0; index < 20; index++) {
    scroller.scrollTop = index % 2 === 0 ? 6000 : 0
    const started = performance.now()
    await frame()
    await frame()
    samples.push(performance.now() - started)
  }
  scroller.scrollTop = 0
  await frame()
  samples.sort((a, b) => a - b)
  // The box this runs on is shared, so the MIN (the least-interrupted rebuild)
  // is the comparable number and p25 shows whether the whole distribution moved.
  return {
    rows: rows(),
    min: samples[0]!,
    p25: samples[Math.floor(samples.length / 4)]!,
    median: samples[Math.floor(samples.length / 2)]!,
    max: samples.at(-1)!,
  }
})
console.log(
  `\n-- window rebuild (scroll far/back, 2 frames): rows=${rebuild.rows}` +
    ` min=${Math.round(rebuild.min * 100) / 100}ms p25=${Math.round(rebuild.p25 * 100) / 100}ms` +
    ` median=${Math.round(rebuild.median * 100) / 100}ms` +
    ` max=${Math.round(rebuild.max * 100) / 100}ms`,
)

// Visual parity evidence. Three states, because the row's controls are a
// hover-only affordance: at rest, with a row hovered, and with the tooltip its
// copy button owns open. Compare the same three files across two builds.
const shotDir = process.env.PROBE_SHOT_DIR ?? "/tmp/claxedo-row-shape"
// Clip to the review pane's viewport: the row container itself is as tall as
// the whole 500-file corpus (the window's gap divs preserve that geometry), and
// a full-height shot of it is unreadable.
const paneBox = await page.locator("[data-testid='review-pane-root']").last().boundingBox()
const clip = paneBox
  ? { x: paneBox.x, y: paneBox.y, width: paneBox.width, height: Math.min(paneBox.height, 520) }
  : undefined
const list = { screenshot: (options: { path: string }) => page.screenshot({ ...options, clip }) }
await list.screenshot({ path: `${shotDir}/rows-rest.png` })
const hoverTrigger = page
  .locator("[data-review-rendered-files] [data-review-file]")
  .nth(2)
  .locator("[data-slot='accordion-trigger']")
  .first()
await hoverTrigger.hover()
await page.waitForTimeout(300)
await list.screenshot({ path: `${shotDir}/rows-hover.png` })
const copyButton = page
  .locator("[data-review-rendered-files] [data-review-file]")
  .nth(2)
  .locator("[data-slot='session-review-copy-button']")
  .first()
const copyVisible = await copyButton.isVisible().catch(() => false)
if (copyVisible) {
  await copyButton.hover()
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${shotDir}/rows-tooltip.png` })
  const tooltipOpen = await page.locator("[data-component='tooltip']").count()
  console.log(`  tooltip elements open over the copy button: ${tooltipOpen}`)
} else {
  console.log("  copy button not visible while its row is hovered")
}
console.log(`  screenshots: ${shotDir}/rows-{rest,hover,tooltip}.png`)

await browser.close()
await stopApp(app)
process.exit(0)
