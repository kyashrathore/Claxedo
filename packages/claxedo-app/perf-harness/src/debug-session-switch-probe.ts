// TEMP probe (read-only diagnosis): the fast meter for the
// `session-switch-workspace` experiment loop.
//
// It reproduces the scenario driver's FULL 12-cell matrix (browser-runner.ts ->
// sessionSwitchWorkspace: blocks closed / open_file / open_review x within /
// across x cold / warm) end to end in well under a `bun run run` pass, and per
// cell prints completion, session-ready, script/style/layout, the stability
// counters, plus four attribution sections that name WHY a cell is slow:
//   - READY-GATE STAGES     when each clause of the session-ready conjunction
//                           first held (a slow cell names the clause it waits on)
//   - IN-WINDOW REQUESTS    every network read inside the switch window, with
//                           start and duration relative to the trusted pointerdown
//   - ACTIVATION MARKS      the app's own renderer-trace marks (rail message
//                           prefetch start/end, destination timeline mount)
//   - TRACE TASKS           main-thread tasks over 10ms with their top events
// It then runs one extra attribution cell with the review corpus suppressed via
// `content-visibility: hidden`, to size how much of session-readiness is
// coupled to the workspace corpus's rendering work.
//
// For the ONE measured switch (`session_switch_open_review_across_warm`) it
// additionally prints:
//   - session-ready ms                    (destination transcript usable)
//   - destination-workspace-ready ms      (rebuilt panel body above-fold)
//   - old-surface-disposed ms             (previous review root detached)
//   - renderer task intervals > 16.67ms   (each duration, both traced main-
//                                          thread tasks and rAF intervals)
//   - JS / style / layout attribution     (exact trusted-window trace delta)
//   - stability counters                  (mock-authoritative vcs/file/
//                                          workspace/sse requests, plus the
//                                          data-review-rendered-files writes)
// and, for the cheap surrounding cells, the two hard stability gates that are
// currently failing on SAME-workspace switches:
//   (a) panel CLOSED, same workspace: expected 0 vcs + 0 workspace requests
//   (b) Review OPEN,  same workspace: expected 0 data-review-rendered-files
//       rewrites (no review recomputation on session activation)
//
// Run (about 25s, of which ~15s is the deliberate staleness idle below):
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=46087 \
//     bun src/debug-session-switch-probe.ts
// Add PROBE_SKIP_STALE_IDLE=1 for an ~11s run that measures the switch but
// cannot see stability gate (a).
//
// Why those two env vars:
//   CLAXEDO_PERF_SKIP_BUILD=1 makes startApp() serve the EXISTING
//     packages/claxedo-app/dist via `vite preview` instead of spending ~40s
//     rebuilding it, which is the whole point of a fast meter.
//   CLAXEDO_PERF_MOCK_PORT must equal the mock port BAKED INTO that dist at
//     build time (VITE_CLAXEDO_SERVER_URL / VITE_OPENCODE_SERVER_PORT). The
//     bundle hard-codes the backend origin, so a mismatched port means the app
//     talks to a port nothing is routed on and the probe hangs on an empty
//     screen. Read the baked port out of the dist with:
//       grep -ohE '127\.0\.0\.1:[0-9]{4,5}' ../dist/assets/*.js | sort | uniq -c
//     (the frequent one is the mock port; 3000 is an unrelated default). At
//     the time of writing that is 46087. Drop CLAXEDO_PERF_SKIP_BUILD to have
//     startApp() rebuild the dist for whatever port you pass instead.
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
} from "./isolated-interaction"
import { seedForScenario } from "./seed"
import {
  SESSION_SWITCH_SUBSTANTIAL_FILE_PATH,
  sessionSwitchCellPrefix,
  type SessionSwitchBlock,
  type SessionSwitchScope,
  type SessionSwitchTemperature,
  type StabilityRequestCounts,
} from "./session-switch-workspace-contract"

const SCENARIO = "session-switch-workspace" as const
const RENDERER_DEADLINE_MS = 16.67
const WORKSPACE_PANEL_TOGGLE_SELECTOR = "[data-testid='workspace-panel-toggle']"
const PANEL_CONTENT_SELECTOR = "[data-testid='review-pane-root']"
const REVIEW_TAB_SELECTOR =
  "[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='review'] > button"

/**
 * The session-ready gate is a conjunction. `stageMs` records when each of its
 * clauses FIRST held, so a slow cell names the clause that is still false
 * instead of leaving the whole gate as one opaque number.
 */
const READY_STAGES = [
  "root",
  "firstFoldReady",
  "messagesReady",
  "messageCount",
  "timelineRoot",
  "revealReady",
  "progressiveReady",
  "visible",
  "keyCount",
  "rowText",
] as const
type ReadyStage = (typeof READY_STAGES)[number]

type ProbeObservation = {
  completionMs: number
  acknowledgedMs?: number
  timedOut: boolean
  sessionReadyMs?: number
  oldWorkspaceDisposedMs?: number
  destinationWorkspaceReadyMs?: number
  stageMs?: Partial<Record<ReadyStage, number>>
  activationMarks?: Array<{ name: string; atMs: number }>
  requests?: Array<{ name: string; startMs: number; durationMs: number }>
}

/**
 * In-page readiness loop. One serialized copy of the two loops the driver
 * uses (`observeSessionSwitchReady` and `observeCrossWorkspaceSessionSwitch`
 * in browser-runner.ts, both module-private): `cross: false` waits only on the
 * destination session's own clock, `cross: true` additionally runs the old-
 * surface-disposal and destination-workspace clocks. Keep in sync with the
 * driver — this probe is only useful while it measures the same thing.
 */
const observeSwitch = async (params: {
  mark: string
  timeoutMs: number
  sessionId: string
  cross: boolean
  newDirectory: string
  oldDirectory: string
  expectedTotal: number
}): Promise<ProbeObservation> => {
  const started = performance.getEntriesByName(params.mark, "mark").at(-1)?.startTime
  if (started === undefined) throw new Error(`Trusted session switch did not emit pointerdown for ${params.sessionId}`)
  const visible = (element: Element) => {
    if (element.closest("[aria-hidden='true']")) return false
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const root = () =>
    document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(params.sessionId)}"]`)
  const stageMs: Partial<Record<ReadyStage, number>> = {}
  const stage = (name: ReadyStage, held: boolean, elapsed: number) => {
    if (held && stageMs[name] === undefined) stageMs[name] = elapsed
    return held
  }
  const sessionReady = (elapsed: number) => {
    const target = root()
    if (!stage("root", !!target && !target.closest("[aria-hidden='true']"), elapsed) || !target) return false
    const foldReady = stage("firstFoldReady", target.dataset.sessionFirstFoldReady === "true", elapsed)
    const messagesReady = stage("messagesReady", target.dataset.sessionMessagesReady === "true", elapsed)
    const counted = stage(
      "messageCount",
      Number(target.dataset.sessionMessageCount ?? target.dataset.sessionConversationCount ?? "0") > 0,
      elapsed,
    )
    const timeline = target.querySelector<HTMLElement>("[data-session-timeline-root]")
    if (!stage("timelineRoot", !!timeline, elapsed) || !timeline) return false
    const revealReady = stage("revealReady", timeline.dataset.sessionTimelineRevealReady === "true", elapsed)
    const progressiveReady = stage("progressiveReady", timeline.dataset.sessionTimelineProgressiveReady === "true", elapsed)
    const shown = stage("visible", getComputedStyle(timeline).visibility !== "hidden", elapsed)
    const keyed = stage("keyCount", Number(timeline.dataset.sessionTimelineKeyCount ?? "0") > 0, elapsed)
    const texted = stage(
      "rowText",
      Array.from(timeline.querySelectorAll<HTMLElement>("[data-timeline-key]")).some((row) => (row.textContent ?? "").trim()),
      elapsed,
    )
    return foldReady && messagesReady && counted && revealReady && progressiveReady && shown && keyed && texted
  }
  const shell = () => document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
  const oldContent = (window as unknown as { __claxedoPerfOldPanelContent?: HTMLElement }).__claxedoPerfOldPanelContent
  const destinationReady = () => {
    const current = shell()
    if (!current || current.dataset.open !== "true" || !visible(current)) return false
    const dir = current.dataset.stateWorkspaceDir ?? ""
    if (dir === params.oldDirectory || !dir.includes(params.newDirectory)) return false
    const reviewRoot = Array.from(current.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    if (!reviewRoot) return false
    const corpus = reviewRoot.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    const reviewReady = !!corpus && Number(corpus.dataset.reviewTotalFiles ?? "0") === params.expectedTotal &&
      Array.from(reviewRoot.querySelectorAll<HTMLElement>("[data-review-file]")).some(visible)
    const fileReady = Array.from(current.querySelectorAll<HTMLElement>("[data-testid='tab-file-root'][data-tab-file-state='ready']"))
      .some(visible)
    const navigator = Array.from(current.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator']")).find(visible)
    const navigatorReady = navigator?.getAttribute("data-file-tree-data-ready") === "true" ||
      !!navigator?.querySelector("[data-file-tree-path]")
    return reviewReady || fileReady || navigatorReady
  }
  let acknowledgedMs: number | undefined
  let sessionReadyMs: number | undefined
  let oldWorkspaceDisposedMs: number | undefined
  let destinationWorkspaceReadyMs: number | undefined
  let stableFrames = 0
  const completionMs = await new Promise<number>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - started
      if (acknowledgedMs === undefined && root()) acknowledgedMs = elapsed
      if (sessionReadyMs === undefined && sessionReady(elapsed)) sessionReadyMs = elapsed
      if (params.cross) {
        if (oldWorkspaceDisposedMs === undefined && oldContent && !oldContent.isConnected) oldWorkspaceDisposedMs = elapsed
        if (destinationWorkspaceReadyMs === undefined && destinationReady()) destinationWorkspaceReadyMs = elapsed
      }
      const done = params.cross
        ? sessionReadyMs !== undefined && oldWorkspaceDisposedMs !== undefined && destinationWorkspaceReadyMs !== undefined
        : sessionReadyMs !== undefined
      stableFrames = done ? stableFrames + 1 : 0
      if (stableFrames >= 2 || elapsed >= params.timeoutMs) return resolve(elapsed)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const requests = performance.getEntriesByType("resource")
    .filter((entry) => entry.startTime >= started && !entry.name.startsWith("data:"))
    .map((entry) => {
      const url = new URL(entry.name)
      return { name: `${url.pathname}${url.search}`.slice(0, 110), startMs: entry.startTime - started, durationMs: entry.duration }
    })
  const activationMarks = performance.getEntriesByType("mark")
    // The app's own activation marks (renderer-trace.ts): when the rail issued
    // the session's message prefetch, when it landed, and when the destination
    // timeline mounted. They are what separate transport wait from render work.
    .filter((entry) => (entry.name.startsWith("sessionActivate.") || entry.name.startsWith("timeline.")) && entry.startTime >= started)
    .map((entry) => ({ name: entry.name, atMs: entry.startTime - started }))
  for (const entry of activationMarks) performance.clearMarks(entry.name)
  performance.clearMarks(params.mark)
  delete (window as unknown as { __claxedoPerfOldPanelContent?: HTMLElement }).__claxedoPerfOldPanelContent
  return {
    completionMs,
    acknowledgedMs,
    timedOut: completionMs >= params.timeoutMs,
    sessionReadyMs,
    stageMs,
    activationMarks,
    requests,
    ...(params.cross ? { oldWorkspaceDisposedMs, destinationWorkspaceReadyMs } : {}),
  }
}

const round = (value: number) => Math.round(value * 100) / 100
const ms = (value: number | undefined) => (value === undefined ? "n/a" : `${round(value)}ms`)

async function syntheticVisibleClick(page: Page, selector: string) {
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
  }, expectedTotal, { timeout: 20_000 })
}

/**
 * The files navigator lives behind the panel's "Open Files" control (inside
 * `[data-testid='workspace-navigator-overlay']`), which the driver reaches via
 * measureWorkspaceFiles before it opens a file tab.
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
    const overlay = navigator.closest<HTMLElement>("[data-testid='workspace-navigator-overlay']")
    if (overlay && (overlay.dataset.open !== "true" || overlay.getAttribute("aria-hidden") === "true")) return false
    return navigator.getAttribute("data-file-tree-data-ready") === "true" ||
      !!navigator.querySelector("[data-file-tree-path]")
  }, undefined, { timeout: 10_000 })
}

/** Same precondition the driver's Block B establishes: one substantial file tab open. */
async function openWorkspaceFileTab(page: Page, filePath: string) {
  await openFilesNavigator(page)
  const navigator = page.locator("[data-testid='workspace-files-navigator'][data-mode='files']").last()
  const search = navigator.locator("input[placeholder='Search files...']").first()
  await search.waitFor({ state: "visible", timeout: 5_000 })
  await search.fill(filePath)
  const row = navigator.locator(`[data-file-tree-path="${filePath}"]`).first()
  await row.waitFor({ state: "visible", timeout: 5_000 })
  await row.click({ timeout: 5_000 })
  await page.waitForFunction((filePath) => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    return !!shell?.querySelector(
      `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(filePath)}"][data-tab-file-state='ready']`,
    )
  }, filePath, { timeout: 10_000 })
}

/** Same precondition the driver's Block C establishes: first diff expanded. */
async function openFirstReviewDiff(page: Page) {
  const item = page.locator("#review-panel [data-review-file]").first()
  await item.waitFor({ state: "visible", timeout: 5_000 })
  const trigger = item.locator('[data-testid$="-trigger"]').first()
  const renderedBefore = await page.evaluate(() => Number(
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
      .find((node) => !node.closest("[aria-hidden='true']"))
      ?.dataset.reviewRenderedHunks ?? "0",
  ))
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click({ timeout: 5_000 })
  await page.waitForFunction((before) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
      .some((node) => !node.closest("[aria-hidden='true']") && Number(node.dataset.reviewRenderedHunks ?? "0") > before),
  renderedBefore, { timeout: 10_000 })
  await page.waitForFunction(() => {
    const review = document.querySelector("#review-panel [data-review-diff-style]")
    return !!review?.getAttribute("data-review-diff-style") && Number(review.getAttribute("data-review-rendered-hunks") ?? "0") > 0
  }, undefined, { timeout: 10_000 })
}

const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const expectedTotal = fixture.changedFiles.length
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

const sessions = fixture.sessions
const home = sessions[0]!
console.log(`[probe] app=${app.baseUrl} mock=${app.mockPort} corpus=${expectedTotal} files`)
console.log(`[probe] workspace A=${fixture.workspaceDirectories[0]}  workspace B=${fixture.workspaceDirectories[1]}`)

await launchTo(page, app, sessionPath(home, home.id))
await waitForTranscript(page, fixture, home.id, home.title)
console.log(`[probe] home session ready (${elapsed()})`)

// --- The measured-cell machinery, mirroring sessionSwitchWorkspace's runCell.

const sessionRowActivate = async (target: (typeof sessions)[number]): Promise<Locator> => {
  const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${target.id}"]`).first()
  if (await row.count()) {
    const activate = row.locator('[data-slot="navigation-row-activate"]').first()
    return (await activate.count()) ? activate : row
  }
  return page.locator("[role='button'], button, a").filter({ hasText: target.title }).first()
}

const stampWorkspaceIdentity = async () => {
  await page.evaluate((contentSelector) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    if (shell) (shell as unknown as Record<string, unknown>).__claxedoPerfShellToken = true
    const content = Array.from(document.querySelectorAll<HTMLElement>(contentSelector)).find(visible)
    if (content) {
      ;(content as unknown as Record<string, unknown>).__claxedoPerfContentToken = true
      ;(window as unknown as Record<string, unknown>).__claxedoPerfOldPanelContent = content
    }
    const w = window as unknown as { __claxedoPerfReviewChurn?: number; __claxedoPerfChurnObserver?: MutationObserver }
    w.__claxedoPerfChurnObserver?.disconnect()
    w.__claxedoPerfReviewChurn = 0
    const corpus = document.querySelector("[data-review-rendered-files][data-review-total-files]")
    if (corpus) {
      const observer = new MutationObserver((records) => {
        w.__claxedoPerfReviewChurn = (w.__claxedoPerfReviewChurn ?? 0) +
          records.filter((record) => record.attributeName === "data-review-rendered-files").length
      })
      observer.observe(corpus, { attributes: true, attributeFilter: ["data-review-rendered-files"] })
      w.__claxedoPerfChurnObserver = observer
    }
  }, PANEL_CONTENT_SELECTOR)
}

const readWorkspaceIdentity = async () =>
  await page.evaluate((contentSelector) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const content = Array.from(document.querySelectorAll<HTMLElement>(contentSelector)).find(visible)
    const w = window as unknown as { __claxedoPerfReviewChurn?: number; __claxedoPerfChurnObserver?: MutationObserver }
    w.__claxedoPerfChurnObserver?.disconnect()
    return {
      shellTokenPreserved: shell ? (shell as unknown as Record<string, unknown>).__claxedoPerfShellToken === true : false,
      contentTokenPreserved: content ? (content as unknown as Record<string, unknown>).__claxedoPerfContentToken === true : false,
      reviewRenderedFilesChurn: w.__claxedoPerfReviewChurn ?? 0,
    }
  }, PANEL_CONTENT_SELECTOR)

type CellResult = {
  cell: string
  metric: FrameMetric
  observation: ProbeObservation
  requestDelta: StabilityRequestCounts
  reviewChurn?: number
  shellTokenPreserved?: boolean
  contentTokenPreserved?: boolean
  settleMs: number
  settled: boolean
}

const completions = new Map<string, number>()
const results: CellResult[] = []

const runCell = async (input: {
  block: SessionSwitchBlock
  scope: SessionSwitchScope
  temperature: SessionSwitchTemperature
  target: (typeof sessions)[number]
  panelOpen: boolean
  /** Attribution cells rename the row and clock only the session. */
  label?: string
  sessionClockOnly?: boolean
}): Promise<CellResult> => {
  const cell = input.label ?? sessionSwitchCellPrefix(input.block, input.scope, input.temperature)
  if (input.panelOpen) await stampWorkspaceIdentity()
  const requestsBefore = { ...fixture.requestCounts.stability }
  const control = await sessionRowActivate(input.target)
  await control.scrollIntoViewIfNeeded().catch(() => undefined)
  const prepared = await prepareTrustedInteraction(page, control, cell)
  const oldDirectory = input.panelOpen
    ? await page.evaluate(() =>
        document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")?.dataset.stateWorkspaceDir ?? "")
    : ""
  const cross = input.scope === "across" && input.panelOpen && !input.sessionClockOnly
  const { metric, observation } = await measureIsolatedInteraction<ProbeObservation>(page, cell, async () => {
    await page.mouse.click(prepared.x, prepared.y)
    return await page.evaluate(observeSwitch, {
      mark: prepared.mark,
      timeoutMs: ISOLATED_INTERACTION_TIMEOUT_MS,
      sessionId: input.target.id,
      cross,
      newDirectory: input.target.directory,
      oldDirectory,
      expectedTotal,
    })
  })
  completions.set(`${input.block}:${input.scope}:${input.temperature}`, observation.completionMs)
  const gate = await settleBeforeNextInteraction(page)
  const requestDelta: StabilityRequestCounts = {
    vcs: fixture.requestCounts.stability.vcs - requestsBefore.vcs,
    file: fixture.requestCounts.stability.file - requestsBefore.file,
    workspace: fixture.requestCounts.stability.workspace - requestsBefore.workspace,
    sse: fixture.requestCounts.stability.sse - requestsBefore.sse,
  }
  const identity = input.panelOpen ? await readWorkspaceIdentity() : undefined
  const result: CellResult = {
    cell,
    metric,
    observation,
    requestDelta,
    reviewChurn: identity?.reviewRenderedFilesChurn,
    shellTokenPreserved: identity?.shellTokenPreserved,
    contentTokenPreserved: identity?.contentTokenPreserved,
    settleMs: round(gate.waitedMs),
    settled: gate.settled,
  }
  results.push(result)
  console.log(
    `[cell] ${cell.padEnd(42)} completion=${ms(observation.completionMs).padStart(9)}` +
      ` session_ready=${ms(observation.sessionReadyMs).padStart(9)}` +
      ` vcs=${requestDelta.vcs} file=${requestDelta.file} ws=${requestDelta.workspace} sse=${requestDelta.sse}` +
      (identity ? ` reviewWrites=${identity.reviewRenderedFilesChurn}` : "") +
      `  (+${elapsed()})`,
  )
  return result
}

// --- Staleness idle. The workspace/VCS runtime queries carry a 15s staleTime
// (src/platform/runtime/workspace-query.ts, http-backend.ts). In the full
// `bun run run` pass Block A starts well past that window, so its same-
// workspace switch hits stale entries and refetches — which IS stability gate
// (a). This probe reaches Block A ~1.5s after boot, where the entries are
// still fresh and the gate passes vacuously. Idling past the window is what
// makes gate (a) reproducible here instead of run-order luck.
// PROBE_SKIP_STALE_IDLE=1 drops it when only the Block C timings are wanted.
const STALE_WINDOW_MS = 16_000
if (process.env.PROBE_SKIP_STALE_IDLE !== "1") {
  const pageClock = await page.evaluate(() => performance.now())
  const idleMs = Math.max(0, STALE_WINDOW_MS - pageClock)
  console.log(`\n[probe] idling ${Math.round(idleMs)}ms so the 15s-staleTime runtime entries have lapsed (PROBE_SKIP_STALE_IDLE=1 to skip)`)
  if (idleMs > 0) await page.waitForTimeout(idleMs)
}

// --- Block A: panel CLOSED. Cheap, and it owns stability gate (a) plus the
// closed baseline the workspace-open penalty is measured against.
console.log("\n=== Block A: workspace panel CLOSED ===")
await runCell({ block: "closed", scope: "within", temperature: "cold", target: sessions[2]!, panelOpen: false })
await runCell({ block: "closed", scope: "within", temperature: "warm", target: home, panelOpen: false })
await runCell({ block: "closed", scope: "across", temperature: "cold", target: sessions[1]!, panelOpen: false })
await runCell({ block: "closed", scope: "across", temperature: "warm", target: home, panelOpen: false })

// --- Block B: panel OPEN on a substantial file, exactly as the driver stages
// it. Its cold cells are the ones this lane has to move, so the probe carries
// the same 12-cell matrix the scenario driver reports.
console.log("\n=== Precondition: panel open, substantial file tab open ===")
await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR)
await waitForWorkspaceReviewContent(page, expectedTotal)
console.log(`[probe] review corpus rendered (${elapsed()})`)
await openWorkspaceFileTab(page, SESSION_SWITCH_SUBSTANTIAL_FILE_PATH)
console.log(`[probe] file tab ${SESSION_SWITCH_SUBSTANTIAL_FILE_PATH} ready (${elapsed()})`)
const openFilePrecondition = await settleBeforeNextInteraction(page)
console.log(`[probe] open_file precondition settle=${round(openFilePrecondition.waitedMs)}ms settled=${openFilePrecondition.settled} (${elapsed()})`)

console.log("\n=== Block B: workspace panel OPEN on a substantial file ===")
await runCell({ block: "open_file", scope: "within", temperature: "cold", target: sessions[4]!, panelOpen: true })
await runCell({ block: "open_file", scope: "within", temperature: "warm", target: home, panelOpen: true })
await runCell({ block: "open_file", scope: "across", temperature: "cold", target: sessions[3]!, panelOpen: true })
await runCell({ block: "open_file", scope: "across", temperature: "warm", target: home, panelOpen: true })

// --- Precondition for Block C, identical to the driver's: the review tab back
// in front of the 500-file corpus, with the first diff expanded.
console.log("\n=== Precondition: review tab active, first diff expanded ===")
await syntheticVisibleClick(page, REVIEW_TAB_SELECTOR)
await waitForWorkspaceReviewContent(page, expectedTotal)
await openFirstReviewDiff(page)
const precondition = await settleBeforeNextInteraction(page)
console.log(`[probe] review warm + first diff expanded; settle=${round(precondition.waitedMs)}ms settled=${precondition.settled} (${elapsed()})`)

// --- Block C: Review OPEN. The within cells own stability gate (b); the final
// across/warm cell is the measured switch this probe exists for.
console.log("\n=== Block C: Review OPEN on the large corpus ===")
await runCell({ block: "open_review", scope: "within", temperature: "cold", target: sessions[6]!, panelOpen: true })
await runCell({ block: "open_review", scope: "within", temperature: "warm", target: home, panelOpen: true })
await runCell({ block: "open_review", scope: "across", temperature: "cold", target: sessions[5]!, panelOpen: true })
const measured = await runCell({ block: "open_review", scope: "across", temperature: "warm", target: home, panelOpen: true })

// --- Rank-7 attribution cell. The first-fold reveal's pre-paint work reads
// layout on the document the workspace panel just enlarged, so the claim is
// that session readiness is coupled to the review corpus's size. Suppress the
// corpus's rendering work with `content-visibility: hidden` and run one more
// COLD cell of the same shape: whatever the reveal is charged for the corpus
// shows up as the delta against `session_switch_open_review_across_cold`.
// `cross` clocks are dropped for this cell — its destination workspace is
// deliberately not rendering.
console.log("\n=== Attribution: same cold cell with the review corpus content-visibility:hidden ===")
await page.addStyleTag({
  content: "[data-testid='review-pane-root'], [data-testid='review-pane-root'] * { content-visibility: hidden !important; }",
})
await settleBeforeNextInteraction(page)
const suppressed = await runCell({
  block: "open_review",
  scope: "across",
  temperature: "cold",
  target: sessions[7]!,
  panelOpen: true,
  sessionClockOnly: true,
  label: "attribution_open_review_cold_corpus_hidden",
})
const corpusCold = results.find((result) => result.cell === "session_switch_open_review_across_cold")
console.log(
  `[attribution] corpus rendering ON  session_ready=${ms(corpusCold?.observation.sessionReadyMs)}` +
    `  vs corpus HIDDEN session_ready=${ms(suppressed.observation.sessionReadyMs)}`,
)

// --- The measured switch, in full.
const causal = measured.metric.causal
const performanceDelta = causal?.performance
const overDeadline = (values: number[] | undefined) => (values ?? []).filter((value) => value > RENDERER_DEADLINE_MS)

console.log(`\n================ MEASURED SWITCH: ${measured.cell} ================`)
console.log(`(cross-workspace, Review open + warm; destination = ${home.id} in ${home.directory})`)
console.log(`  completion                    ${ms(measured.observation.completionMs)}`)
console.log(`  acknowledged                  ${ms(measured.observation.acknowledgedMs)}`)
console.log(`  session-ready                 ${ms(measured.observation.sessionReadyMs)}   <- the < 50ms goal`)
console.log(`  destination-workspace-ready   ${ms(measured.observation.destinationWorkspaceReadyMs)}`)
console.log(`  old-surface-disposed          ${ms(measured.observation.oldWorkspaceDisposedMs)}`)
console.log(`  timed out                     ${measured.observation.timedOut}`)

const closedAcrossWarm = completions.get("closed:across:warm")
if (closedAcrossWarm !== undefined) {
  console.log(
    `  workspace-open penalty        ${ms(measured.observation.completionMs - closedAcrossWarm)}` +
      ` (open ${ms(measured.observation.completionMs)} - closed ${ms(closedAcrossWarm)})`,
  )
}

console.log("\n-- JS / style / layout attribution for the switch window --")
if (!causal) {
  console.log("  no causal capture; set CLAXEDO_PERF_CAUSAL=1")
} else {
  console.log(`  source                        ${causal.performanceSource ?? "unknown"}${causal.performanceUnavailableReason ? ` (${causal.performanceUnavailableReason})` : ""}`)
  console.log(`  script (JS)                   ${ms(performanceDelta?.scriptMs)}`)
  console.log(`  recalc style                  ${ms(performanceDelta?.recalcStyleMs)}`)
  console.log(`  layout                        ${ms(performanceDelta?.layoutMs)}`)
  console.log(`  total task                    ${ms(performanceDelta?.taskMs)}`)
  console.log(`  DOM                           +${causal.dom.nodesAdded} nodes / -${causal.dom.nodesRemoved} nodes / ${causal.dom.attributesChanged} attrs`)
  const resources = causal.resources.filter((resource) => !resource.name.startsWith("data:"))
  console.log(`  resource requests in window   ${resources.length}`)
  for (const resource of resources.slice(0, 12)) {
    console.log(`      page-clock t=${round(resource.startTime)}ms ${resource.initiatorType} ${new URL(resource.name, app.baseUrl).pathname}`)
  }
  for (const phase of causal.rendererPhases ?? []) {
    if (phase.durationMs >= 5) console.log(`  renderer phase                ${phase.name}: ${phase.durationMs}ms`)
  }
  for (const task of (causal.traceTasks ?? []).filter((task) => task.durationMs > RENDERER_DEADLINE_MS)) {
    console.log(`  trace task ${task.durationMs}ms`)
    for (const event of task.events.slice(0, 6)) {
      console.log(`      ${String(event.durationMs).padStart(8)}ms  ${event.name}${event.detail ? ` :: ${event.detail}` : ""}`)
    }
  }
}

console.log("\n-- renderer intervals over 16.67ms --")
const longTasks = overDeadline(measured.metric.mainThreadTasksMs)
const longIntervals = overDeadline(measured.metric.observedFrameIntervalsMs ?? measured.metric.frameIntervalsMs)
console.log(`  main-thread tasks > 16.67ms   ${longTasks.length} of ${measured.metric.mainThreadTasksMs?.length ?? 0}: [${longTasks.map(round).join(", ")}]`)
console.log(`  rAF intervals    > 16.67ms    ${longIntervals.length} of ${measured.metric.sampleCount}: [${longIntervals.map(round).join(", ")}]`)
console.log(`  worst renderer interval       ${ms(measured.metric.worstFrameMs)}   p95 ${ms(measured.metric.p95FrameMs)}   verdict ${measured.metric.verdict}`)
console.log(`  framesOver1667 (metric)       ${measured.metric.framesOver1667}`)

console.log("\n-- stability counters for the measured switch --")
console.log(`  vcs=${measured.requestDelta.vcs} file=${measured.requestDelta.file} workspace=${measured.requestDelta.workspace} sse=${measured.requestDelta.sse}`)
console.log(`  data-review-rendered-files writes: ${measured.reviewChurn ?? "n/a"}`)
console.log(`  shell identity preserved: ${measured.shellTokenPreserved}  content identity preserved: ${measured.contentTokenPreserved} (cross-workspace: content SHOULD be rebuilt)`)

// --- The two hard stability gates, evaluated exactly as the contract does.
console.log("\n================ STABILITY GATES (same-workspace switches) ================")
for (const result of results) {
  if (!result.cell.includes("_within_")) continue
  const panelClosed = result.cell.includes("_closed_")
  const failures: string[] = []
  if (panelClosed) {
    if (result.requestDelta.vcs !== 0) failures.push(`${result.requestDelta.vcs} vcs requests; expected 0`)
    if (result.requestDelta.workspace !== 0) failures.push(`${result.requestDelta.workspace} workspace requests; expected 0`)
    if (result.requestDelta.file !== 0) failures.push(`${result.requestDelta.file} file requests; expected 0`)
  } else {
    if (result.reviewChurn) failures.push(`${result.reviewChurn} data-review-rendered-files writes; expected 0`)
    if (result.shellTokenPreserved === false) failures.push("workspace panel shell was rebuilt; expected preserved")
    if (result.contentTokenPreserved === false) failures.push("workspace panel body was rebuilt; expected preserved")
  }
  console.log(`  ${failures.length ? "FAIL" : "PASS"}  ${result.cell.padEnd(42)} ${failures.join(" | ") || "clean"}`)
}

console.log("\n================ ALL CELLS ================")
for (const result of results) {
  console.log(
    `  ${result.cell.padEnd(42)} completion=${ms(result.observation.completionMs).padStart(9)}` +
      ` session_ready=${ms(result.observation.sessionReadyMs).padStart(9)}` +
      ` script=${ms(result.metric.causal?.performance?.scriptMs).padStart(9)}` +
      ` style=${ms(result.metric.causal?.performance?.recalcStyleMs).padStart(9)}` +
      ` layout=${ms(result.metric.causal?.performance?.layoutMs).padStart(8)}` +
      ` worstFrame=${ms(result.metric.worstFrameMs).padStart(9)}` +
      ` settle=${result.settleMs}ms`,
  )
}
console.log("\n================ READY-GATE STAGES PER CELL ================")
for (const result of results) {
  const stages = result.observation.stageMs ?? {}
  const rendered = READY_STAGES
    .map((name) => `${name}=${stages[name] === undefined ? "never" : `${round(stages[name]!)}ms`}`)
    .join(" ")
  console.log(`  ${result.cell.padEnd(42)} ${rendered}`)
}

console.log("\n================ IN-WINDOW REQUESTS PER CELL ================")
for (const result of results) {
  const requests = result.observation.requests ?? []
  if (!requests.length) continue
  console.log(`  ${result.cell}  (session_ready=${ms(result.observation.sessionReadyMs)})`)
  for (const request of requests.slice(0, 10)) {
    console.log(`      start=${String(round(request.startMs)).padStart(8)}ms dur=${String(round(request.durationMs)).padStart(7)}ms ${request.name}`)
  }
}

console.log("\n================ ACTIVATION MARKS PER CELL ================")
for (const result of results) {
  const marks = result.observation.activationMarks ?? []
  if (!marks.length) continue
  console.log(`  ${result.cell}  (session_ready=${ms(result.observation.sessionReadyMs)})`)
  for (const mark of marks) console.log(`      ${String(round(mark.atMs)).padStart(8)}ms  ${mark.name}`)
}

console.log("\n================ TRACE TASKS PER CELL (> 10ms) ================")
for (const result of results) {
  const tasks = (result.metric.causal?.traceTasks ?? []).filter((task) => task.durationMs > 10)
  if (!tasks.length) continue
  console.log(`  ${result.cell}  (session_ready=${ms(result.observation.sessionReadyMs)})`)
  for (const task of tasks) {
    console.log(`    task ${round(task.durationMs)}ms`)
    for (const event of task.events.slice(0, 8)) {
      console.log(`      ${String(round(event.durationMs)).padStart(8)}ms  ${event.name}${event.detail ? ` :: ${event.detail}` : ""}`)
    }
  }
}

console.log("\n================ RENDERER PHASES PER CELL (>= 1ms) ================")
for (const result of results) {
  const phases = (result.metric.causal?.rendererPhases ?? []).filter((phase) => phase.durationMs >= 1)
  if (!phases.length) continue
  console.log(`  ${result.cell}`)
  for (const phase of phases) console.log(`      ${String(round(phase.durationMs)).padStart(8)}ms  ${phase.name}`)
}

console.log(`\n[probe] total runtime ${elapsed()}`)

await browser.close()
await stopApp(app)
process.exit(0)
