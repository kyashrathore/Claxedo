// TEMP probe (read-only diagnosis): the fast meter for the
// `review-construct` experiment loop.
//
// It reproduces, end to end and in well under a `bun run run` pass, the five
// clicks whose per-click cost the review-construction work is judged on:
//
//   1. panel_open        first workspace-panel open on the 500-file corpus
//                        (the lifecycle "data-ready -> above-fold" clock, plus
//                        the construction task behind the settle gate)
//   2. files_to_review   activating the Review tab from a file tab
//   3. diff_expand       expanding ONE collapsed review row
//   4. diff_collapse     collapsing that same row again
//   5. review_to_files   activating the file tab again
//
// For every click it prints completion / acknowledged / script / recalc-style
// / layout / total-task / worst renderer interval / DOM delta, plus the review
// corpus counters (`data-review-rendered-files`, `data-review-total-files`,
// `data-review-rendered-hunks`) so a change that trades work for a smaller
// materialization is visible rather than silent. Long trace tasks over the
// renderer deadline are printed with their top events, which is how the
// per-click script/style split is attributed to a real call.
//
// The readiness predicates are serialized copies of the scenario driver's
// (`observeWorkspacePanelInteraction` and the lifecycle cold-open loop in
// browser-runner.ts, both module-private). Keep them in sync — this probe is
// only useful while it measures what the benchmark measures.
//
// Run (about 60s warm, plus a ~40s production build on the first run):
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_MOCK_PORT=47123 bun src/debug-review-construct-probe.ts
//   # reruns, once the dist is baked for that port:
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=47123 \
//     bun src/debug-review-construct-probe.ts
//
// CLAXEDO_PERF_SKIP_BUILD=1 makes startApp() serve the EXISTING
// packages/claxedo-app/dist through `vite preview` instead of rebuilding it,
// and CLAXEDO_PERF_MOCK_PORT must equal the mock port baked into that dist
// (the bundle hard-codes the backend origin). Read the baked port with:
//   grep -ohE '127\.0\.0\.1:[0-9]{4,5}' ../dist/assets/*.js | sort | uniq -c
//
// The probe never touches application source; it only drives the built app.
import { chromium, type Locator, type Page } from "@playwright/test"
// Causal attribution (script/style/layout + the trusted-window trace) is
// opt-in inside frame-sampler, read at call time. The probe exists to print
// that attribution, so it turns the flag on for itself unless overridden.
process.env.CLAXEDO_PERF_CAUSAL ??= "1"

import { frameSamplingLaunchArgs, type FrameMetric } from "./frame-sampler"
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
import {
  ISOLATED_INTERACTION_TIMEOUT_MS,
  measureIsolatedInteraction,
  prepareTrustedInteraction,
  settleBeforeNextInteraction,
  type IsolatedInteractionObservation,
} from "./isolated-interaction"
import { seedForScenario } from "./seed"
import {
  WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX,
  WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS,
} from "./workspace-interactions-contract"

const SCENARIO = "workspace-interactions" as const
const RENDERER_DEADLINE_MS = 16.67
const TARGET_MS = 50
const WORKSPACE_PANEL_TOGGLE_SELECTOR = "[data-testid='workspace-panel-toggle']"

type ProbeMode =
  | { kind: "panel-open" }
  | { kind: "activate-review" }
  | { kind: "activate-file"; filePath: string }
  | { kind: "expand-diff"; filePath: string; renderedHunksBefore: number }
  | { kind: "collapse-diff"; filePath: string }

type ProbeObservation = IsolatedInteractionObservation & {
  /**
   * Page-clock time of the trusted pointerdown. The causal recorder reports
   * resource timings on the same clock, so this is what turns a raw
   * `startTime` into "N ms after the click" — the number that says whether a
   * chunk load is on the open path or already warm.
   */
  startedMs: number
  renderedFiles: number
  totalFiles: number
  renderedHunks: number
  rowExpanded: boolean
  rowContentMounted: boolean
  /**
   * For the diff modes: whether the row element stamped before the click is
   * still the row element after it. A row that is REBUILT (rather than having
   * its content mounted into it) pays for its Accordion.Item, its sticky
   * header and its whole expanded subtree twice.
   */
  rowElementPreserved?: boolean
}

/**
 * One self-contained in-page readiness loop for every measured click. Passed
 * to `page.evaluate`, so it may not reference module scope.
 */
const observeReviewInteraction = async (params: {
  mark: string
  timeoutMs: number
  expectedTotal: number
  mode: ProbeMode
}): Promise<ProbeObservation> => {
  const started = performance.getEntriesByName(params.mark, "mark").at(-1)?.startTime
  if (started === undefined) throw new Error(`Trusted ${params.mode.kind} did not emit pointerdown`)
  const visible = (element: Element) => {
    if (element.closest("[aria-hidden='true']")) return false
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const shell = () => document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
  const reviewRoot = () => {
    const current = shell()
    return current
      ? Array.from(current.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
      : undefined
  }
  const corpusNode = () =>
    reviewRoot()?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]") ?? undefined
  const diffNode = () => {
    const node = reviewRoot()?.querySelector<HTMLElement>("[data-review-diff-style]")
    return node && !node.closest("[aria-hidden='true']") ? node : undefined
  }
  const renderedHunks = () => Number(diffNode()?.dataset.reviewRenderedHunks ?? "0")
  const renderedFiles = () => Number(corpusNode()?.dataset.reviewRenderedFiles ?? "0")
  const totalFiles = () => Number(corpusNode()?.dataset.reviewTotalFiles ?? "0")
  const mode = params.mode
  const diffRow = () => {
    const filePath = "filePath" in mode ? mode.filePath : undefined
    if (!filePath) return undefined
    return reviewRoot()?.querySelector<HTMLElement>(`[data-review-file="${CSS.escape(filePath)}"]`) ?? undefined
  }
  const rowState = () => {
    const row = diffRow()
    const wrapper = row?.querySelector<HTMLElement>("[data-slot='session-review-diff-wrapper']")
    return {
      expanded: row?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded") === "true",
      contentMounted: !!wrapper,
      contentRendered: !!wrapper && wrapper.childElementCount > 0 &&
        !wrapper.querySelector("[data-slot='session-review-diff-placeholder']") &&
        !wrapper.querySelector("[data-slot='session-review-large-diff']"),
    }
  }
  const reviewCorpusReady = () => {
    const root = reviewRoot()
    if (!root) return false
    if (totalFiles() !== params.expectedTotal) return false
    if (!Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]")).some(visible)) return false
    return !root.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
  }
  const loadingVisible = () => {
    const current = shell()
    if (!current) return false
    if (Array.from(current.querySelectorAll("[data-testid='workspace-file-tab-deferred']")).some(visible)) return true
    return Array.from(current.querySelectorAll<HTMLElement>("div, span"))
      .some((node) => visible(node) && node.children.length === 0 && node.textContent?.trim() === "Loading...")
  }
  const acknowledge = (): boolean => {
    switch (mode.kind) {
      case "panel-open":
        return !!shell()
      case "activate-review":
        return !!shell()?.querySelector(
          "[data-slot='workspace-tab'][data-workspace-tab-kind='review'][data-selected='true']",
        )
      case "activate-file":
        return !!shell()?.querySelector(
          `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(mode.filePath)}"]`,
        )
      case "expand-diff":
        return rowState().expanded
      case "collapse-diff":
        return !rowState().expanded
    }
  }
  const ready = (): boolean => {
    switch (mode.kind) {
      case "panel-open": {
        const current = shell()
        if (!current || !visible(current) || current.getBoundingClientRect().width <= 120) return false
        return reviewCorpusReady()
      }
      case "activate-review":
        return reviewCorpusReady()
      case "activate-file": {
        const root = shell()?.querySelector<HTMLElement>(
          `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(mode.filePath)}"][data-tab-file-state='ready']`,
        )
        return !!root && visible(root) && !loadingVisible()
      }
      case "expand-diff": {
        const state = rowState()
        return state.expanded && state.contentRendered && renderedHunks() > mode.renderedHunksBefore
      }
      case "collapse-diff": {
        const state = rowState()
        return !state.expanded && !state.contentMounted
      }
    }
  }
  let acknowledgedMs: number | undefined
  let stableFrames = 0
  let lastSignature = ""
  const completionMs = await new Promise<number>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - started
      if (acknowledgedMs === undefined && acknowledge()) acknowledgedMs = elapsed
      const isReady = ready()
      const signature = JSON.stringify([renderedFiles(), totalFiles(), renderedHunks(), rowState()])
      stableFrames = isReady && signature === lastSignature ? stableFrames + 1 : isReady ? 1 : 0
      lastSignature = signature
      if (stableFrames >= 2 || elapsed >= params.timeoutMs) return resolve(elapsed)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  performance.clearMarks(params.mark)
  const settled = rowState()
  const stampedRow = (window as unknown as { __claxedoPerfRow?: HTMLElement }).__claxedoPerfRow
  const currentRow = diffRow()
  return {
    completionMs,
    acknowledgedMs,
    timedOut: completionMs >= params.timeoutMs,
    startedMs: started,
    renderedFiles: renderedFiles(),
    totalFiles: totalFiles(),
    renderedHunks: renderedHunks(),
    rowExpanded: settled.expanded,
    rowContentMounted: settled.contentMounted,
    ...(stampedRow ? { rowElementPreserved: !!currentRow && currentRow === stampedRow } : {}),
  }
}

const round = (value: number) => Math.round(value * 100) / 100
const ms = (value: number | undefined) => (value === undefined ? "n/a" : `${round(value)}ms`)

async function waitForWorkspaceReviewContent(page: Page, expectedTotal: number) {
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
  }, expectedTotal, { timeout: 25_000 })
}

/**
 * The files navigator lives behind the panel's "Open Files" control; the
 * driver reaches it the same way before opening a file tab.
 */
async function openFilesNavigator(page: Page) {
  await page.evaluate(() => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" &&
        style.pointerEvents !== "none"
    }
    const control = Array.from(document.querySelectorAll<HTMLElement>(
      "button[aria-label='Open Files'], [role='button'][aria-label='Open Files']",
    )).find(visible)
    if (!control) throw new Error("no visible 'Open Files' control on the workspace panel")
    control.click()
  })
  await page.waitForFunction(() => {
    const navigator = document.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")
    if (!navigator) return false
    return navigator.getAttribute("data-file-tree-data-ready") === "true" ||
      !!navigator.querySelector("[data-file-tree-path]")
  }, undefined, { timeout: 15_000 })
}

async function openWorkspaceFileTab(page: Page, filePath: string) {
  const navigator = page.locator("[data-testid='workspace-files-navigator'][data-mode='files']").last()
  const search = navigator.locator("input[placeholder='Search files...']").first()
  await search.waitFor({ state: "visible", timeout: 10_000 })
  await search.fill(filePath)
  const row = navigator.locator(`[data-file-tree-path="${filePath}"]`).first()
  await row.waitFor({ state: "visible", timeout: 10_000 })
  await row.click({ timeout: 10_000 })
  await page.waitForFunction((filePath) => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    return !!shell?.querySelector(
      `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(filePath)}"][data-tab-file-state='ready']`,
    )
  }, filePath, { timeout: 20_000 })
}

const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const expectedTotal = fixture.changedFiles.length
const expandPath = fixture.changedFiles[WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX]!.file
const [fileA, fileB] = WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS
const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 400)))
page.on("console", (message) => {
  if (message.type() === "error") console.log("[console error]", message.text().slice(0, 300))
})

const probeStarted = performance.now()
const elapsed = () => `${Math.round(performance.now() - probeStarted)}ms`

await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)

const session = fixture.sessions[0]!
console.log(`[probe] app=${app.baseUrl} mock=${app.mockPort} corpus=${expectedTotal} files expand=${expandPath}`)

await launchTo(page, app, sessionPath(session, session.id))
await waitForTranscript(page, fixture, session.id, session.title)
console.log(`[probe] session ready (${elapsed()})`)

type CellResult = {
  cell: string
  metric: FrameMetric
  observation: ProbeObservation
  settleMs: number
  settled: boolean
}

const results: CellResult[] = []

const runCell = async (input: {
  cell: string
  control: Locator
  mode: ProbeMode
}): Promise<CellResult> => {
  const control = input.control
  await control.scrollIntoViewIfNeeded().catch(() => undefined)
  // Row identity across the click, for the diff modes.
  await page.evaluate((filePath) => {
    const target = window as unknown as { __claxedoPerfRow?: HTMLElement }
    delete target.__claxedoPerfRow
    if (!filePath) return
    const row = document.querySelector<HTMLElement>(
      `[data-testid='review-pane-root'] [data-review-file="${CSS.escape(filePath)}"]`,
    )
    if (row) target.__claxedoPerfRow = row
  }, "filePath" in input.mode ? input.mode.filePath : undefined)
  const prepared = await prepareTrustedInteraction(page, control, input.cell)
  const { metric, observation } = await measureIsolatedInteraction<ProbeObservation>(page, input.cell, async () => {
    await page.mouse.click(prepared.x, prepared.y)
    return await page.evaluate(observeReviewInteraction, {
      mark: prepared.mark,
      timeoutMs: ISOLATED_INTERACTION_TIMEOUT_MS,
      expectedTotal,
      mode: input.mode,
    })
  })
  const gate = await settleBeforeNextInteraction(page)
  const result: CellResult = {
    cell: input.cell,
    metric,
    observation,
    settleMs: round(gate.waitedMs),
    settled: gate.settled,
  }
  results.push(result)
  const causal = metric.causal?.performance
  console.log(
    `[cell] ${input.cell.padEnd(18)} completion=${ms(observation.completionMs).padStart(9)}` +
      ` ack=${ms(observation.acknowledgedMs).padStart(9)}` +
      ` script=${ms(causal?.scriptMs).padStart(9)}` +
      ` style=${ms(causal?.recalcStyleMs).padStart(9)}` +
      ` layout=${ms(causal?.layoutMs).padStart(8)}` +
      ` worst=${ms(metric.worstFrameMs).padStart(8)}` +
      ` rows=${observation.renderedFiles}/${observation.totalFiles}` +
      ` hunks=${observation.renderedHunks}` +
      (observation.rowElementPreserved === undefined ? "" : ` rowKept=${observation.rowElementPreserved}`) +
      ` settle=${result.settleMs}ms  (+${elapsed()})`,
  )
  return result
}

// --- 1. Panel open on the 500-file corpus (the construction behind the gate).
await runCell({
  cell: "panel_open",
  control: page.locator(WORKSPACE_PANEL_TOGGLE_SELECTOR).last(),
  mode: { kind: "panel-open" },
})
await waitForWorkspaceReviewContent(page, expectedTotal)

// --- Precondition: two file tabs open (the driver's Files<->Review material).
await openFilesNavigator(page)
for (const filePath of [fileA!, fileB!]) await openWorkspaceFileTab(page, filePath)
await settleBeforeNextInteraction(page)
console.log(`[probe] file tabs open, active=${fileB} (${elapsed()})`)

// `.first()` throughout: each tab renders its label button AND a close
// button, and grabbing the last one would dismiss the tab instead of
// activating it.
const fileTabButton = (filePath: string) =>
  page
    .locator("[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='file']")
    .filter({ hasText: filePath.split("/").at(-1)! })
    .first()
    .locator("button")
    .first()
const reviewTabButton = () =>
  page
    .locator("[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='review'] button")
    .first()

// --- 2. Files -> Review.
await runCell({
  cell: "files_to_review",
  control: reviewTabButton(),
  mode: { kind: "activate-review" },
})

// --- 3/4. Expand then collapse ONE row, through its own trigger.
const diffTrigger = () =>
  page
    .locator(`[data-testid='review-pane-root'] [data-review-file="${expandPath}"]`)
    .locator("[data-testid$='-trigger']")
    .first()
const hunksBefore = await page.evaluate(() => {
  const node = Array.from(document.querySelectorAll<HTMLElement>("[data-review-diff-style]"))
    .find((item) => !item.closest("[aria-hidden='true']"))
  return Number(node?.dataset.reviewRenderedHunks ?? "0")
})
await runCell({
  cell: "diff_expand",
  control: diffTrigger(),
  mode: { kind: "expand-diff", filePath: expandPath, renderedHunksBefore: hunksBefore },
})
await runCell({
  cell: "diff_collapse",
  control: diffTrigger(),
  mode: { kind: "collapse-diff", filePath: expandPath },
})

// --- 5. Review -> Files, back onto an open, already-loaded file tab.
await runCell({
  cell: "review_to_files",
  control: fileTabButton(fileB!),
  mode: { kind: "activate-file", filePath: fileB! },
})

// --- Per-click attribution.
for (const result of results) {
  const causal = result.metric.causal
  console.log(`\n================ ${result.cell} ================`)
  console.log(`  completion                    ${ms(result.observation.completionMs)}   ${result.observation.completionMs <= TARGET_MS ? "<= 50ms" : "OVER 50ms"}`)
  console.log(`  acknowledged                  ${ms(result.observation.acknowledgedMs)}`)
  console.log(`  timed out                     ${result.observation.timedOut}`)
  console.log(`  review rows / total           ${result.observation.renderedFiles} / ${result.observation.totalFiles}`)
  console.log(`  rendered hunks                ${result.observation.renderedHunks}`)
  console.log(`  row expanded / content        ${result.observation.rowExpanded} / ${result.observation.rowContentMounted}`)
  if (result.observation.rowElementPreserved !== undefined) {
    console.log(`  row element preserved         ${result.observation.rowElementPreserved}`)
  }
  if (!causal) {
    console.log("  no causal capture; set CLAXEDO_PERF_CAUSAL=1")
  } else {
    const performanceDelta = causal.performance
    console.log(`  source                        ${causal.performanceSource ?? "unknown"}${causal.performanceUnavailableReason ? ` (${causal.performanceUnavailableReason})` : ""}`)
    console.log(`  script (JS)                   ${ms(performanceDelta?.scriptMs)}`)
    console.log(`  recalc style                  ${ms(performanceDelta?.recalcStyleMs)}`)
    console.log(`  layout                        ${ms(performanceDelta?.layoutMs)}`)
    console.log(`  total task                    ${ms(performanceDelta?.taskMs)}`)
    console.log(`  DOM                           +${causal.dom.nodesAdded} / -${causal.dom.nodesRemoved} nodes, ${causal.dom.attributesChanged} attrs`)
    const resources = causal.resources.filter((resource) => !resource.name.startsWith("data:"))
    console.log(`  resource requests in window   ${resources.length}`)
    // Offsets are click-relative (`startedMs` is the trusted pointerdown on
    // the same clock): a script row here IS a module the open path waited on,
    // and `+dur` is how long the open path waited for it.
    for (const resource of resources.slice(0, 12)) {
      const start = resource.startTime - result.observation.startedMs
      console.log(
        `      click+${round(start).toString().padStart(8)}ms dur=${round(resource.duration).toString().padStart(7)}ms` +
          ` end=+${round(start + resource.duration).toString().padStart(8)}ms` +
          ` ${resource.initiatorType.padEnd(6)} ${new URL(resource.name, app.baseUrl).pathname}`,
      )
    }
    for (const task of (causal.traceTasks ?? []).filter((task) => task.durationMs > RENDERER_DEADLINE_MS)) {
      console.log(`  trace task ${task.durationMs}ms`)
      for (const event of task.events.slice(0, 8)) {
        console.log(`      ${String(event.durationMs).padStart(8)}ms  ${event.name}${event.detail ? ` :: ${event.detail}` : ""}`)
      }
    }
  }
  const longTasks = (result.metric.mainThreadTasksMs ?? []).filter((value) => value > RENDERER_DEADLINE_MS)
  const longIntervals = (result.metric.observedFrameIntervalsMs ?? result.metric.frameIntervalsMs ?? [])
    .filter((value) => value > RENDERER_DEADLINE_MS)
  console.log(`  main-thread tasks > 16.67ms   ${longTasks.length}: [${longTasks.map(round).join(", ")}]`)
  console.log(`  rAF intervals    > 16.67ms    ${longIntervals.length}: [${longIntervals.map(round).join(", ")}]`)
  console.log(`  worst renderer interval       ${ms(result.metric.worstFrameMs)}   p95 ${ms(result.metric.p95FrameMs)}`)
  console.log(`  settle gate                   ${result.settleMs}ms settled=${result.settled}`)
}

console.log("\n================ SUMMARY (target: every completion <= 50ms) ================")
for (const result of results) {
  const causal = result.metric.causal?.performance
  console.log(
    `  ${result.cell.padEnd(18)} completion=${ms(result.observation.completionMs).padStart(9)}` +
      ` script=${ms(causal?.scriptMs).padStart(9)}` +
      ` style=${ms(causal?.recalcStyleMs).padStart(9)}` +
      ` layout=${ms(causal?.layoutMs).padStart(8)}` +
      ` worst=${ms(result.metric.worstFrameMs).padStart(8)}` +
      `  ${result.observation.completionMs <= TARGET_MS ? "PASS" : "OVER"}`,
  )
}
console.log(`\n[probe] total runtime ${elapsed()}`)

await browser.close()
await stopApp(app)
process.exit(0)
