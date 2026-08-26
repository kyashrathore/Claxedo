// TEMP probe (read-only diagnosis): attribute the style-recalculation cost of a
// SAME-workspace session switch while the Review panel is open and warm
// (`session-switch-workspace`, block C: open_review / within / warm-cold).
//
// It measures with the SAME source counters the harness gates on
// (CDP Performance.RecalcStyleDuration / LayoutDuration / ScriptDuration), so
// the numbers are directly comparable to the scenario's `*_style_ms` metrics,
// and adds three attributions the scenario cannot give:
//
//   1. a shadow-DOM-aware element census of every candidate subtree, so
//      "how many elements can a recalc touch" is a measured number;
//   2. forced-recalc microbenchmarks (ms per ONE full recalc of each subtree),
//      which price a single broad invalidation;
//   3. an A/B of the switch itself across {panel closed, Review mounted with
//      the diff expanded, Review mounted with the diff collapsed}, plus a
//      simulated row re-render, so the recomputation defect's share of the
//      style cost is measured rather than inferred.
//
// Run:
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=46087 \
//     bun src/debug-review-style-attribution.ts
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

const scenario = "session-switch-workspace" as const
const app = await startApp()
const fixture = fixtureFor(scenario, seedForScenario(scenario))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 400)))

await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)

const sessions = fixture.sessions
const home = sessions[0]!
const withinCold = sessions[6]!
const withinCold2 = sessions[4]!
const withinCold3 = sessions[2]!
const expectedTotal = fixture.changedFiles.length

const cdp = await page.context().newCDPSession(page)
await cdp.send("Performance.enable" as never, { timeDomain: "threadTicks" } as never)

type Counters = { style: number; layout: number; script: number; task: number; styleCount: number; layoutCount: number }
async function counters(): Promise<Counters> {
  const response = (await cdp.send("Performance.getMetrics" as never)) as { metrics: Array<{ name: string; value: number }> }
  const read = (name: string) => response.metrics.find((metric) => metric.name === name)?.value ?? 0
  return {
    style: read("RecalcStyleDuration") * 1000,
    layout: read("LayoutDuration") * 1000,
    script: read("ScriptDuration") * 1000,
    task: read("TaskDuration") * 1000,
    styleCount: read("RecalcStyleCount"),
    layoutCount: read("LayoutCount"),
  }
}
const delta = (before: Counters, after: Counters) => ({
  styleMs: after.style - before.style,
  layoutMs: after.layout - before.layout,
  scriptMs: after.script - before.script,
  taskMs: after.task - before.task,
  recalcs: after.styleCount - before.styleCount,
  layouts: after.layoutCount - before.layoutCount,
})

async function visibleClick(selector: string) {
  await page.evaluate((selector) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const target = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible).at(-1)
    if (!target) throw new Error(`No visible element for synthetic click: ${selector}`)
    target.click()
  }, selector)
}

async function waitForReviewContent() {
  await page.waitForFunction((expectedTotal) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    if (!shell || !visible(shell) || shell.getBoundingClientRect().width <= 120) return false
    const root = Array.from(shell.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    if (!root) return false
    const corpus = root.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    if (!corpus || Number(corpus.dataset.reviewTotalFiles ?? "0") !== expectedTotal) return false
    if (!Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]")).some(visible)) return false
    return !root.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
  }, expectedTotal, { timeout: 20_000 })
}

// Shadow-aware census: the expanded diff renders inside <diffs-container>'s
// shadow root, which a light-DOM querySelectorAll never sees.
async function census(label: string) {
  const facts = await page.evaluate(() => {
    const countTree = (root: Node): { elements: number; shadowHosts: number; shadowElements: number } => {
      let elements = 0
      let shadowHosts = 0
      let shadowElements = 0
      const walk = (node: Element) => {
        elements++
        const shadow = (node as HTMLElement).shadowRoot
        if (shadow) {
          shadowHosts++
          for (const child of Array.from(shadow.querySelectorAll("*"))) {
            shadowElements++
            const nested = (child as HTMLElement).shadowRoot
            if (nested) shadowElements += nested.querySelectorAll("*").length
          }
        }
        for (const child of Array.from(node.children)) walk(child)
      }
      if (root instanceof Element) walk(root)
      else for (const child of Array.from((root as Document).children)) walk(child)
      return { elements, shadowHosts, shadowElements }
    }
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const reviewRoot = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    const corpus = reviewRoot?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    const diffHosts = reviewRoot ? Array.from(reviewRoot.querySelectorAll("diffs-container")) : []
    const rows = reviewRoot ? Array.from(reviewRoot.querySelectorAll<HTMLElement>("[data-review-file]")) : []
    const sessionRoot = document.querySelector<HTMLElement>("[data-testid='session-page-root']")
    const rail = document.querySelector<HTMLElement>("[data-testid='rail-sidebar']")
    // Every stylesheet in every tree scope, so shadow-scoped rule counts show.
    let shadowRules = 0
    const shadowSheets: Array<{ host: string; rules: number }> = []
    const collect = (root: ShadowRoot) => {
      let rules = 0
      for (const sheet of [...root.styleSheets, ...(root.adoptedStyleSheets ?? [])]) {
        try {
          const count = (list: CSSRuleList) => {
            for (const rule of Array.from(list)) {
              rules++
              const nested = (rule as CSSGroupingRule).cssRules
              if (nested) count(nested)
            }
          }
          count(sheet.cssRules)
        } catch {}
      }
      shadowRules += rules
      shadowSheets.push({ host: (root.host as HTMLElement).tagName.toLowerCase(), rules })
    }
    const seen = new Set<string>()
    for (const element of Array.from(document.querySelectorAll("*"))) {
      const shadow = (element as HTMLElement).shadowRoot
      if (!shadow) continue
      const key = (element as HTMLElement).tagName
      collect(shadow)
      seen.add(key)
    }
    let documentRules = 0
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const count = (list: CSSRuleList) => {
          for (const rule of Array.from(list)) {
            documentRules++
            const nested = (rule as CSSGroupingRule).cssRules
            if (nested) count(nested)
          }
        }
        count(sheet.cssRules)
      } catch {}
    }
    return {
      document: countTree(document),
      reviewRoot: reviewRoot ? countTree(reviewRoot) : null,
      corpus: corpus ? countTree(corpus) : null,
      rows: rows.length,
      renderedFiles: corpus?.dataset.reviewRenderedFiles,
      totalFiles: corpus?.dataset.reviewTotalFiles,
      diffHosts: diffHosts.length,
      diffShadowElements: diffHosts.reduce(
        (sum, host) => sum + ((host as HTMLElement).shadowRoot?.querySelectorAll("*").length ?? 0),
        0,
      ),
      sessionRoot: sessionRoot ? countTree(sessionRoot) : null,
      rail: rail ? countTree(rail) : null,
      documentRules,
      shadowRules,
      shadowSheets: shadowSheets.sort((a, b) => b.rules - a.rules).slice(0, 6),
      shadowHostTags: [...seen],
    }
  })
  console.log(`\n======== census: ${label} ========`)
  console.log(JSON.stringify(facts, null, 1))
  return facts
}

// One forced recalc of a subtree, priced with the harness's own counter.
// A probe stylesheet gives every descendant of `.claxedo-probe-invalidate` a
// declaration, so toggling that class is a guaranteed whole-subtree
// invalidation with no visual effect (outline-style stays `none`).
async function installProbeStylesheet() {
  await page.addStyleTag({
    content: ".claxedo-probe-invalidate, .claxedo-probe-invalidate * { outline-color: currentColor }",
  })
}

async function priceSubtreeRecalc(label: string, selector: string, iterations = 24) {
  const before = await counters()
  const ok = await page.evaluate(
    ({ selector, iterations }) => {
      const visible = (element: Element) => {
        if (element.closest("[aria-hidden='true']")) return false
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
      const target =
        selector === ":root"
          ? document.documentElement
          : Array.from(document.querySelectorAll<HTMLElement>(selector)).find(visible)
      if (!target) return false
      for (let index = 0; index < iterations; index++) {
        target.classList.toggle("claxedo-probe-invalidate")
        void document.body.offsetHeight
      }
      target.classList.remove("claxedo-probe-invalidate")
      void document.body.offsetHeight
      return true
    },
    { selector, iterations },
  )
  const after = await counters()
  if (!ok) {
    console.log(`  ${label.padEnd(38)} (no element for ${selector})`)
    return 0
  }
  const measured = delta(before, after)
  const per = measured.styleMs / iterations
  console.log(
    `  ${label.padEnd(38)} ${per.toFixed(2).padStart(7)}ms/recalc   (style ${measured.styleMs.toFixed(1)}ms over ${iterations} forced recalcs, layout ${measured.layoutMs.toFixed(1)}ms)`,
  )
  return per
}

// Simulate the recomputation defect: rebuild the corpus's rows from clones,
// which is what a Solid re-render of the `For` over `windowSegments()` costs
// the style engine (new nodes -> initial style for the whole row subtree).
async function priceRowRerender(iterations = 8) {
  const before = await counters()
  const ok = await page.evaluate((iterations) => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const root = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    const accordion = corpus?.querySelector<HTMLElement>("[data-component='accordion']")
    if (!accordion) return false
    const original = Array.from(accordion.childNodes)
    for (let index = 0; index < iterations; index++) {
      const clones = original.map((node) => node.cloneNode(true))
      accordion.replaceChildren(...clones)
      void document.body.offsetHeight
    }
    accordion.replaceChildren(...original)
    void document.body.offsetHeight
    return true
  }, iterations)
  const after = await counters()
  if (!ok) {
    console.log("  (no accordion to re-render)")
    return 0
  }
  const measured = delta(before, after)
  console.log(
    `  ${"rebuild every review row (clone)".padEnd(38)} ${(measured.styleMs / iterations).toFixed(2).padStart(7)}ms/rebuild  (style ${measured.styleMs.toFixed(1)}ms, layout ${measured.layoutMs.toFixed(1)}ms over ${iterations})`,
  )
  return measured.styleMs / iterations
}

const activate = (sessionId: string) =>
  page
    .locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${sessionId}"]`)
    .first()
    .locator('[data-slot="navigation-row-activate"]')
    .first()

async function armReviewChurn() {
  await page.evaluate(() => {
    const w = window as unknown as { __churn?: number; __churnObserver?: MutationObserver; __adds?: number; __removes?: number }
    w.__churnObserver?.disconnect()
    w.__churn = 0
    w.__adds = 0
    w.__removes = 0
    const corpus = document.querySelector("[data-review-rendered-files][data-review-total-files]")
    if (!corpus) return
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.attributeName === "data-review-rendered-files") w.__churn = (w.__churn ?? 0) + 1
        w.__adds = (w.__adds ?? 0) + record.addedNodes.length
        w.__removes = (w.__removes ?? 0) + record.removedNodes.length
      }
    })
    observer.observe(corpus, { attributes: true, attributeFilter: ["data-review-rendered-files"], childList: true, subtree: true })
    w.__churnObserver = observer
  })
}

async function readReviewChurn() {
  return await page.evaluate(() => {
    const w = window as unknown as { __churn?: number; __churnObserver?: MutationObserver; __adds?: number; __removes?: number }
    w.__churnObserver?.disconnect()
    return { churn: w.__churn ?? 0, adds: w.__adds ?? 0, removes: w.__removes ?? 0 }
  })
}

// Which subtree did each style recalc pass actually walk? `ResolveStyle` is
// emitted per element under the invalidationTracking category and carries
// nodeId + parentNodeId; grouping consecutive events into passes and naming
// each pass's roots (from the invalidation records that do carry nodeName)
// attributes the recalc to a subtree instead of to a guess.
async function tracedSwitchAttribution(label: string, sessionId: string, windowMs = 1_500) {
  const events: any[] = []
  const collect = (payload: { value?: any[] }) => {
    for (const event of payload.value ?? []) events.push(event)
  }
  ;(cdp as any).on("Tracing.dataCollected", collect)
  await cdp.send("Tracing.start" as never, {
    categories: "-*,disabled-by-default-devtools.timeline.invalidationTracking,blink.user_timing",
    transferMode: "ReportEvents",
  } as never)
  const control = activate(sessionId)
  await control.scrollIntoViewIfNeeded().catch(() => undefined)
  const box = await control.boundingBox()
  if (!box) throw new Error(`no bounding box for ${sessionId}`)
  await page.evaluate(() => {
    performance.clearMarks("probe_click")
    performance.mark("probe_click")
  })
  const before = await counters()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(windowMs)
  const after = await counters()
  const done = new Promise<void>((resolve) => (cdp as any).once("Tracing.tracingComplete", () => resolve()))
  await cdp.send("Tracing.end" as never)
  await done
  ;(cdp as any).off("Tracing.dataCollected", collect)

  const click = events.find((event) => event.name === "probe_click")?.ts ?? 0
  const names = new Map<number, string>()
  for (const event of events) {
    const data = event.args?.data
    if (data?.nodeId && data?.nodeName) names.set(data.nodeId, data.nodeName)
  }
  const resolves = events
    .filter((event) => event.name === "StyleResolver::ResolveStyle")
    .sort((a, b) => a.ts - b.ts)
  const passes: any[][] = []
  let current: any[] = []
  let last: number | undefined
  for (const event of resolves) {
    if (last !== undefined && event.ts - last > 5_000) {
      passes.push(current)
      current = []
    }
    current.push(event)
    last = event.ts
  }
  if (current.length) passes.push(current)
  const measured = delta(before, after)
  console.log(
    `\n  [${label}] style=${measured.styleMs.toFixed(1)}ms layout=${measured.layoutMs.toFixed(1)}ms script=${measured.scriptMs.toFixed(1)}ms recalcPasses=${measured.recalcs} elementsResolved=${resolves.length}`,
  )
  for (const pass of [...passes].sort((a, b) => b.length - a.length).slice(0, 8)) {
    const ids = new Set(pass.map((event) => event.args.data.nodeId))
    const roots = new Map<number, number>()
    for (const event of pass) {
      const data = event.args.data
      if (!ids.has(data.parentNodeId)) roots.set(data.nodeId, (roots.get(data.nodeId) ?? 0) + 1)
    }
    const described = [...roots.keys()].slice(0, 4).map((id) => `${id}:${(names.get(id) ?? "?").slice(0, 58)}`)
    console.log(
      `     pass elements=${String(pass.length).padStart(6)}  start=+${((pass[0].ts - click) / 1000).toFixed(0).padStart(5)}ms  roots=${roots.size}  ${described.join(" | ")}`,
    )
  }
  return { ...measured, elementsResolved: resolves.length }
}

// Per-frame geometry sampling of the Review viewport during a switch. The row
// window is derived from `scrollTop` / `clientHeight` / measured row heights,
// so any of those moving is what re-runs the window memo.
async function geometrySwitch(label: string, sessionId: string, windowMs = 1_400) {
  await page.evaluate(() => {
    const w = window as unknown as { __geo?: any[]; __geoStop?: boolean }
    w.__geo = []
    w.__geoStop = false
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const sample = () => {
      if (w.__geoStop) return
      const root = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
      const scroll = root?.querySelector<HTMLElement>("[data-slot='session-review-scroll'] .scroll-view__viewport")
        ?? root?.querySelector<HTMLElement>("[data-slot='session-review-scroll']")
      const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files]")
      const firstRow = root?.querySelector<HTMLElement>("[data-review-file]")
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
      const accordion = corpus?.querySelector<HTMLElement>("[data-component='accordion']")
      w.__geo!.push({
        t: performance.now(),
        scrollTop: scroll?.scrollTop,
        clientHeight: scroll?.clientHeight,
        clientWidth: scroll?.clientWidth,
        rendered: corpus?.dataset.reviewRenderedFiles,
        firstRowHeight: firstRow?.offsetHeight,
        rowCount: root?.querySelectorAll("[data-review-file]").length,
        shellWidth: shell?.getBoundingClientRect().width,
        accordionId: accordion?.id,
        corpusIsConnected: corpus?.isConnected,
      })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  const control = activate(sessionId)
  await control.scrollIntoViewIfNeeded().catch(() => undefined)
  const box = await control.boundingBox()
  if (!box) throw new Error(`no bounding box for ${sessionId}`)
  const before = await counters()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(windowMs)
  const after = await counters()
  const samples = await page.evaluate(() => {
    const w = window as unknown as { __geo?: any[]; __geoStop?: boolean }
    w.__geoStop = true
    return w.__geo ?? []
  })
  const measured = delta(before, after)
  console.log(`\n  [geometry ${label}] style=${measured.styleMs.toFixed(1)}ms  samples=${samples.length}`)
  const start = samples[0]?.t ?? 0
  let previous = ""
  for (const sample of samples) {
    const key = JSON.stringify({ ...sample, t: undefined })
    if (key === previous) continue
    previous = key
    console.log(
      `     +${(sample.t - start).toFixed(0).padStart(5)}ms scrollTop=${sample.scrollTop} clientH=${sample.clientHeight} clientW=${sample.clientWidth} shellW=${Math.round(sample.shellWidth ?? 0)} rendered=${sample.rendered} rows=${sample.rowCount} firstRowH=${sample.firstRowHeight} accordion=${sample.accordionId} corpusConnected=${sample.corpusIsConnected}`,
    )
  }
  return measured
}

async function measuredSwitch(label: string, sessionId: string, windowMs = 900) {
  await armReviewChurn()
  const control = activate(sessionId)
  await control.scrollIntoViewIfNeeded().catch(() => undefined)
  const box = await control.boundingBox()
  if (!box) throw new Error(`no bounding box for ${sessionId}`)
  const before = await counters()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(windowMs)
  const after = await counters()
  const churn = await readReviewChurn()
  const measured = delta(before, after)
  console.log(
    `  ${label.padEnd(46)} style=${measured.styleMs.toFixed(1).padStart(7)}ms  layout=${measured.layoutMs.toFixed(1).padStart(6)}ms  script=${measured.scriptMs.toFixed(1).padStart(7)}ms  recalcPasses=${String(measured.recalcs).padStart(4)}  reviewChurn=${churn.churn} corpusAdds=${churn.adds} corpusRemoves=${churn.removes}`,
  )
  return { ...measured, ...churn }
}

// ---------------------------------------------------------------- run
await launchTo(page, app, sessionPath(home, home.id))
await waitForTranscript(page, fixture, home.id, home.title)
await page.waitForTimeout(2_000)
await installProbeStylesheet()

console.log("\n#### A. panel CLOSED (control) ####")
await measuredSwitch("closed within cold -> s6", withinCold.id)
await page.waitForTimeout(1_500)
await measuredSwitch("closed within warm -> home", home.id)
await page.waitForTimeout(1_500)
await tracedSwitchAttribution("closed within cold (traced) -> s4", withinCold2.id)
await page.waitForTimeout(1_500)
await tracedSwitchAttribution("closed within warm (traced) -> home", home.id)
await page.waitForTimeout(1_500)

// Open the panel and land on the Review tab.
await visibleClick("[data-testid='workspace-panel-toggle']")
await waitForReviewContent()
await page.waitForTimeout(1_500)
await visibleClick(
  "[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='review'] > button",
)
await waitForReviewContent()
await page.waitForTimeout(1_500)

console.log("\n#### B. panel OPEN on Review, diff COLLAPSED ####")
const collapsedCensus = await census("Review mounted, no diff expanded")
console.log("\n-- forced-recalc price of one whole-subtree invalidation --")
await priceSubtreeRecalc("whole document (:root)", ":root")
await priceSubtreeRecalc("review-pane-root", "[data-testid='review-pane-root']")
await priceSubtreeRecalc("review corpus (rows only)", "[data-review-rendered-files]")
await priceSubtreeRecalc("session-page-root (transcript)", "[data-testid='session-page-root']")
await priceSubtreeRecalc("rail-sidebar", "[data-testid='rail-sidebar']")
console.log("\n-- price of re-creating the review rows --")
await priceRowRerender()
console.log("\n-- switches --")
await measuredSwitch("open_review(collapsed) within cold -> s4", withinCold2.id)
await page.waitForTimeout(1_500)
await measuredSwitch("open_review(collapsed) within warm -> home", home.id)
await page.waitForTimeout(1_500)

console.log("\n#### C. panel OPEN on Review, first diff EXPANDED ####")
const firstDiff = page.locator("#review-panel [data-review-file]").first()
await firstDiff.waitFor({ state: "visible", timeout: 5_000 })
const trigger = firstDiff.locator('[data-testid$="-trigger"]').first()
if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click({ timeout: 5_000 })
await page
  .waitForFunction(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]")).some(
        (node) => !node.closest("[aria-hidden='true']") && Number(node.dataset.reviewRenderedHunks ?? "0") > 0,
      ),
    undefined,
    { timeout: 10_000 },
  )
  .catch(() => console.log("[warn] no rendered hunks observed"))
await page.waitForTimeout(2_500)
const expandedCensus = await census("Review mounted, first diff expanded")
console.log("\n-- forced-recalc price of one whole-subtree invalidation --")
const priceDocument = await priceSubtreeRecalc("whole document (:root)", ":root")
const priceReview = await priceSubtreeRecalc("review-pane-root", "[data-testid='review-pane-root']")
const priceCorpus = await priceSubtreeRecalc("review corpus (rows + open diff)", "[data-review-rendered-files]")
await priceSubtreeRecalc("open diff host (diffs-container)", "diffs-container")
await priceSubtreeRecalc("session-page-root (transcript)", "[data-testid='session-page-root']")
console.log("\n-- price of re-creating the review rows --")
const priceRebuild = await priceRowRerender()
console.log("\n-- switches --")
const expandedCold = await measuredSwitch("open_review(expanded) within cold -> s2", withinCold3.id)
await page.waitForTimeout(1_500)
const expandedWarm = await measuredSwitch("open_review(expanded) within warm -> home", home.id)
await page.waitForTimeout(1_500)
const expandedCold2 = await measuredSwitch("open_review(expanded) within cold -> s6", withinCold.id)
await page.waitForTimeout(1_500)
const expandedWarm2 = await measuredSwitch("open_review(expanded) within warm -> home", home.id)
await page.waitForTimeout(1_500)
await tracedSwitchAttribution("open_review(expanded) within cold (traced) -> s4", withinCold2.id)
await page.waitForTimeout(1_500)
await tracedSwitchAttribution("open_review(expanded) within warm (traced) -> home", home.id)
await page.waitForTimeout(1_500)
await geometrySwitch("open_review(expanded) within cold -> s4", withinCold2.id)
await page.waitForTimeout(1_500)
await geometrySwitch("open_review(expanded) within warm -> home", home.id)
await page.waitForTimeout(1_500)
await census("after traced switches")

console.log("\n======== ATTRIBUTION ========")
console.log(`one full-document recalc            ${priceDocument.toFixed(2)}ms`)
console.log(`one review-pane-root recalc         ${priceReview.toFixed(2)}ms`)
console.log(`one review-corpus recalc            ${priceCorpus.toFixed(2)}ms`)
console.log(`one rebuild of every review row     ${priceRebuild.toFixed(2)}ms`)
for (const [label, value] of [
  ["expanded cold", expandedCold],
  ["expanded warm", expandedWarm],
  ["expanded cold #2", expandedCold2],
  ["expanded warm #2", expandedWarm2],
] as const) {
  console.log(
    `${label.padEnd(20)} switch style=${value.styleMs.toFixed(1)}ms => ${(value.styleMs / (priceReview || 1)).toFixed(1)}x a full review recalc; rebuild share if 1 rebuild = ${((priceRebuild / (value.styleMs || 1)) * 100).toFixed(0)}%`,
  )
}
console.log(
  `census collapsed: review=${JSON.stringify(collapsedCensus.reviewRoot)} corpus=${JSON.stringify(collapsedCensus.corpus)}`,
)
console.log(
  `census expanded : review=${JSON.stringify(expandedCensus.reviewRoot)} corpus=${JSON.stringify(expandedCensus.corpus)} diffShadowElements=${expandedCensus.diffShadowElements}`,
)

await browser.close()
await stopApp(app)
