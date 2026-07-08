import { mkdir, rename } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright"
import { runAttribution } from "./attribution"
import { flowName, type FlowResult } from "./flows"
import { frameSamplingLaunchArgs, measureInteraction, mergeFrameMetrics, type FrameMetric } from "./frame-sampler"
import { applyBudget, jsonReport, markdownReport } from "./report"
import { seedForScenario } from "./seed"
import { summarize } from "./stats"
import { appendTrend, appRoot, ensureBudget, harnessRoot, reportsRoot, writeBaseline, writeJson } from "./storage"
import { app } from "./targets"
import type { AppTarget, Measurement, RunOptions, ScenarioId, ScenarioResult, SeedManifest } from "./types"

type BrowserTarget = {
  target: AppTarget
  baseUrl: string
  mockPort: number
  command: string
  process?: Bun.Subprocess
}

type BrowserRun = Omit<ScenarioResult, "budget" | "status" | "failures" | "warnings"> & {
  validation_failures?: string[]
}

class BrowserScenarioError extends Error {
  constructor(message: string, readonly videoPath?: string) {
    super(message)
    this.name = "BrowserScenarioError"
  }
}

type SessionRequestCountsForValidation = {
  requestCounts: {
    messages: number
    expectedTranscripts: Record<string, string>
    visibleTranscripts: Record<string, boolean>
  }
}

const viewport = { width: 1440, height: 960 }

export async function runBrowser(options: RunOptions) {
  const results: ScenarioResult[] = []
  // vsync/frame-cap disabled so frame intervals reflect main-thread work, not the
  // display refresh — that is what makes the 8.33/16.67ms thresholds meaningful.
  const browser = await chromium.launch({ headless: options.headless, args: frameSamplingLaunchArgs })
  try {
    const target = await startApp()
    try {
      for (const scenario of options.scenarios) {
        try {
          const rawRuns: BrowserRun[] = []
          for (let index = 0; index < options.iterations; index++) {
            rawRuns.push(await executeBrowserScenario(browser, target, scenario, index))
          }
          const merged = mergeBrowserRuns(rawRuns)
          merged.attribution = runAttribution({
            browserVersion: browser.version(),
            server: { baseUrl: target.baseUrl, mockPort: target.mockPort, command: target.command },
          })
          const budget = await ensureBudget(merged)
          const budgeted = applyBudget(merged, budget)
          const result = merged.validation_failures?.length
            ? {
                ...budgeted,
                status: "fail" as const,
                failures: [...budgeted.failures, ...merged.validation_failures],
              }
            : budgeted
          results.push(result)
          if (options.update_baseline) await writeBaseline(result)
          if (options.append_trend) await appendTrend(result)
        } catch (error) {
          results.push(browserScenarioFailure({
            scenario,
            browserVersion: browser.version(),
            app: target,
            error,
          }))
        }
      }
    } finally {
      await stopApp(target)
    }
  } finally {
    await browser.close()
  }

  const output = path.isAbsolute(options.output) ? options.output : path.join(reportsRoot, options.output)
  await writeJson(output, jsonReport(results))
  await Bun.write(output.replace(/\.json$/, ".md"), markdownReport(results, { debug: options.debug }))
  await writeJson(path.join(reportsRoot, "latest.json"), jsonReport(results))
  await Bun.write(path.join(reportsRoot, "latest.md"), markdownReport(results, { debug: options.debug }))
  return results
}

export function browserScenarioFailure(input: {
  scenario: ScenarioId
  browserVersion?: string
  app?: Pick<BrowserTarget, "baseUrl" | "mockPort">
  error: unknown
}): ScenarioResult {
  return {
    adapter: "browser",
    target: "claxedo",
    id: input.scenario,
    name: flowName(input.scenario),
    started_at: new Date().toISOString(),
    duration_ms: 0,
    seed: seedForScenario(input.scenario),
    headline: emptyFrameMetric(input.scenario),
    metrics: [],
    budget: { scenario: input.scenario },
    status: "fail",
    failures: [`browser scenario crashed: ${input.error instanceof Error ? input.error.message : String(input.error)}`],
    warnings: [],
    ...(input.error instanceof BrowserScenarioError && input.error.videoPath
      ? { artifacts: { video: input.error.videoPath } }
      : {}),
    attribution: runAttribution({
      browserVersion: input.browserVersion,
      server: input.app ? { baseUrl: input.app.baseUrl, mockPort: input.app.mockPort } : undefined,
    }),
  }
}

function emptyFrameMetric(label: string): FrameMetric {
  return { label, worstFrameMs: 0, p95FrameMs: 0, framesOver833: 0, framesOver1667: 0, sampleCount: 0, completionMs: 0, verdict: "red" }
}

async function executeBrowserScenario(
  browser: Browser,
  app: BrowserTarget,
  scenario: ScenarioId,
  iteration: number,
): Promise<BrowserRun> {
  const seed = seedForScenario(scenario)
  const fixture = fixtureFor(scenario, seed)
  // Video is always on — one .webm per flow run.
  const context = await browser.newContext({
    viewport,
    permissions: ["clipboard-read", "clipboard-write"],
    recordVideo: { dir: path.join(reportsRoot, "videos", "raw"), size: viewport },
  })
  const page = await context.newPage()
  const monitor = monitorPage(page)
  const started = performance.now()
  await installMockApi(page, app, fixture)
  await installSeedState(page, app.target, fixture)

  try {
    const flow = await runFlow(scenario, page, app, fixture)
    const validation_failures = await validationFailures(page, monitor, scenario, fixture)
    if (process.env.PERF_DEBUG_ERRORS) {
      const body = await page.locator("body").innerText({ timeout: 500 }).catch(() => "")
      console.error(`\n[PERF_DEBUG ${scenario}] pageErrors:`, monitor.pageErrors)
      console.error(`[PERF_DEBUG ${scenario}] consoleErrors:`, monitor.consoleErrors)
      console.error(`[PERF_DEBUG ${scenario}] body[0..800]:`, body.replace(/\s+/g, " ").slice(0, 800))
    }
    const videoPath = await closeContextAndSaveVideo(context, page, app.target, scenario, iteration)
    return {
      adapter: "browser",
      target: app.target,
      id: scenario,
      name: flowName(scenario),
      started_at: new Date().toISOString(),
      duration_ms: performance.now() - started,
      seed,
      headline: flow.headline,
      metrics: flow.debug.map(summarize),
      validation_failures,
      artifacts: videoPath ? { video: path.relative(harnessRoot, videoPath) } : undefined,
    }
  } catch (error) {
    const diagnostics = await browserFailureDiagnostics(page, monitor, error)
    const videoPath = await closeContextAndSaveVideo(context, page, app.target, scenario, iteration)
    throw new BrowserScenarioError(diagnostics, videoPath ? path.relative(harnessRoot, videoPath) : undefined)
  }
}

async function browserFailureDiagnostics(page: Page, monitor: ReturnType<typeof monitorPage>, error: unknown) {
  const base = error instanceof Error ? error.message : String(error)
  const [url, title, body] = await Promise.all([
    page.url(),
    page.title().catch(() => ""),
    page.locator("body").innerText({ timeout: 500 }).catch(() => ""),
  ])
  const details = [
    base,
    `url=${url}`,
    title ? `title=${title}` : undefined,
    body.trim() ? `body=${body.replace(/\s+/g, " ").trim().slice(0, 240)}` : "body=<empty>",
    monitor.pageErrors.length ? `pageErrors=${monitor.pageErrors.slice(-3).join(" | ")}` : undefined,
    monitor.consoleErrors.length ? `consoleErrors=${monitor.consoleErrors.slice(-3).join(" | ")}` : undefined,
    monitor.failedResponses.length ? `failedResponses=${monitor.failedResponses.slice(-5).join(" | ")}` : undefined,
  ].filter((item): item is string => !!item)
  return details.join("; ")
}

function mergeBrowserRuns(rawRuns: BrowserRun[]): BrowserRun {
  return {
    ...rawRuns[0]!,
    duration_ms: rawRuns.reduce((sum, result) => sum + result.duration_ms, 0),
    headline: mergeFrameMetrics(rawRuns[0]!.headline.label, rawRuns.map((result) => result.headline)),
    metrics: rawRuns[0]!.metrics.map((metric, index) =>
      summarize({
        ...metric,
        samples: rawRuns.flatMap((result) => result.metrics[index]?.samples ?? []),
      }),
    ),
    validation_failures: rawRuns.flatMap((result) => result.validation_failures ?? []),
    artifacts: rawRuns.at(-1)?.artifacts,
  }
}

// The flow registry. Each driver returns one headline FrameMetric + debug
// sub-metrics. To add a flow: add it to ScenarioId/FLOWS/seed, then add a driver.
const flowDrivers: Record<ScenarioId, (page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>) => Promise<FlowResult>> = {
  "launch-empty-home": launchEmptyHome,
  "launch-project": launchProject,
  "session-switch": sessionSwitch,
  "live-terminal-switch": liveTerminalSwitch,
  "large-diff-toggle": largeDiffToggle,
  "workspace-switch": workspaceSwitch,
  "three-pane-resize": threePaneResize,
}

async function runFlow(scenario: ScenarioId, page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>) {
  return flowDrivers[scenario](page, app, fixture)
}

// Launch flows: the headline samples the post-load settle (first-frame smoothness)
// while completionMs carries the user-visible time-to-ready. Frame sampling cannot
// span the full navigation because page.goto replaces the document (and our recorder).
async function launchEmptyHome(page: Page, app: BrowserTarget, _fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const launch = await launchTo(page, app, "/")
  const headline = await measureInteraction(page, "launch-empty-home", async () => {
    await focusFirstInput(page)
    await settleForVideo(page)
  })
  headline.completionMs = Math.round(launch.ready * 100) / 100
  return {
    headline,
    debug: [
      lower("launch_first_window_ms", launch.domContentLoaded),
      lower("launch_first_useful_screen_ms", launch.useful),
      lower("launch_workspace_ready_ms", launch.ready),
    ],
  }
}

async function launchProject(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const launch = await launchTo(page, app, workspacePath(fixture.directory))
  await showSessionInventory(page, fixture, fixture.sessions.length)
  const session = fixture.sessions[0]!
  const transcriptMs = await measureInPageSessionFirstFoldSwitch(page, session)
  await waitForTranscript(page, fixture, session.id, session.title)
  const headline = await measureInteraction(page, "launch-project", async () => {
    await settleForVideo(page)
  })
  headline.completionMs = Math.round(launch.ready * 100) / 100
  return {
    headline,
    debug: [
      lower("launch_first_window_ms", launch.domContentLoaded),
      lower("launch_workspace_ready_ms", launch.ready),
      lower("transcript_render_ms", transcriptMs),
    ],
  }
}

async function sessionSwitch(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const first = fixture.sessions[0]!
  const second = fixture.sessions[1] ?? first
  await launchTo(page, app, sessionPath(first, first.id))
  await waitForTranscript(page, fixture, first.id, first.title)
  await showSessionInventory(page, fixture, Math.min(2, fixture.sessions.length))

  let singleSwitchMs = 0
  // Headline: rapid back-and-forth switching between two 10k-message sessions.
  // The frame recorder spans the whole stress loop; monitorPage simultaneously
  // catches any call-stack overflow / error-boundary as a validation failure.
  const headline = await measureInteraction(page, "session-switch", async () => {
    for (let round = 0; round < 3; round++) {
      const started = performance.now()
      await clickVisibleSession(page, fixture, second, { settle: "frame" })
      await page.getByText(second.title, { exact: false }).first().waitFor({ timeout: 10_000 })
      if (round === 0) singleSwitchMs = performance.now() - started
      await clickVisibleSession(page, fixture, first, { settle: "frame" })
      await page.getByText(first.title, { exact: false }).first().waitFor({ timeout: 10_000 })
    }
  })
  await settleForVideo(page)
  return {
    headline,
    debug: [lower("single_switch_ms", Math.round(singleSwitchMs * 100) / 100)],
  }
}

async function liveTerminalSwitch(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  await launchTo(page, app, sessionPath(fixture.sessions[0]!, fixture.sessions[0]!.id))
  await waitForTranscript(page, fixture, fixture.sessions[0]!.id, fixture.sessions[0]!.title)
  await openTerminalSurface(page, fixture, fixture.terminals[0]?.title)
  await openTerminalSurface(page, fixture, fixture.terminals[1]?.title)
  let switchMs = 0
  // Headline: switching between live terminals with active output.
  const headline = await measureInteraction(page, "live-terminal-switch", async () => {
    switchMs = await measureInPageTerminalSwitch(page, fixture.terminals[0]?.title ?? "")
    await openTerminalSurface(page, fixture, fixture.terminals[1]?.title)
    await openTerminalSurface(page, fixture, fixture.terminals[0]?.title)
  })
  if (switchMs >= 4_900) recordVisualFailure(fixture, "terminal switch did not settle before timeout")
  await settleForVideo(page)
  const resizeMs = await measureInPageTerminalResize(page, { width: 1320, height: 860 })
  return {
    headline,
    debug: [
      lower("terminal_switch_ms", Math.round(switchMs * 100) / 100),
      lower("terminal_resize_ms", resizeMs),
    ],
  }
}

async function measureInPageTerminalResize(page: Page, size: { width: number; height: number }): Promise<number> {
  await page.evaluate(() => {
    ;(window as unknown as { __claxedoResizeStart?: number }).__claxedoResizeStart = undefined
    const handler = () => {
      const w = window as unknown as { __claxedoResizeStart?: number }
      if (w.__claxedoResizeStart === undefined) w.__claxedoResizeStart = performance.now()
    }
    window.addEventListener("resize", handler, { once: true })
  })
  await page.setViewportSize(size)
  return await page.evaluate(async () => {
    const w = window as unknown as { __claxedoResizeStart?: number }
    const start = w.__claxedoResizeStart ?? performance.now()
    const fits = (r: DOMRect) => r.width > 100 && r.height > 40
    return await new Promise<number>((resolve) => {
      let stableFrames = 0
      let last = ""
      const limit = 1000
      const tick = () => {
        const elapsed = performance.now() - start
        const els = Array.from(document.querySelectorAll("[data-component='terminal']"))
        const sig = els
          .map((el) => {
            const r = el.getBoundingClientRect()
            return `${Math.round(r.width)}x${Math.round(r.height)}`
          })
          .join("|")
        const hasVisible = els.some((el) => fits(el.getBoundingClientRect()))
        if (hasVisible && sig === last) {
          stableFrames++
          if (stableFrames >= 2) return resolve(elapsed)
        } else {
          stableFrames = 0
          last = sig
        }
        if (elapsed > limit) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })
}

async function measureInPageTerminalSwitch(page: Page, terminalTitle: string): Promise<number> {
  return await page.evaluate(async (title) => {
    const sidebar = document.querySelector("[data-testid='terminal-section']")
    if (!sidebar) return 5000
    const rows = sidebar.querySelectorAll<HTMLElement>("[role='button']")
    let target: HTMLElement | undefined
    for (const row of Array.from(rows)) {
      if (row.textContent && row.textContent.includes(title)) {
        target = row
        break
      }
    }
    if (!target) return 5000
    const fits = (r: DOMRect) => r.width > 100 && r.height > 40

    const start = performance.now()
    target.click()

    return await new Promise<number>((resolve) => {
      const limit = 5000
      let stableVisibleFrames = 0
      const tick = () => {
        const elapsed = performance.now() - start
        const els = Array.from(document.querySelectorAll("[data-component='terminal'], #terminal-panel"))
        const hasVisible = els.some((el) => fits(el.getBoundingClientRect()))
        stableVisibleFrames = hasVisible ? stableVisibleFrames + 1 : 0
        if (stableVisibleFrames >= 2) return resolve(elapsed)
        if (elapsed > limit) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, terminalTitle)
}

async function largeDiffToggle(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  await launchTo(page, app, sessionPath(fixture.sessions[0]!, fixture.sessions[0]!.id))
  await waitForTranscript(page, fixture, fixture.sessions[0]!.id, fixture.sessions[0]!.title)
  const reviewPanelOpenMs = await measureWorkspacePanelOpen(page, fixture)
  const vcsLoadMs = await measureReviewChangedFileReady(page, fixture)
  await waitForReviewChangedFiles(page, fixture, { timeout: 2_000 })
  await moveMouseToReviewPanel(page)
  const hunkRenderMs = await measureInPageReviewScroll(page, 1600)
  await waitForReviewStable(page)
  // Headline: toggling split/unified on a 500-file diff — the canonical diff jank.
  const headline = await measureInteraction(page, "large-diff-toggle", async () => {
    await toggleDiffStyle(page, { settle: "video" })
    await waitForReviewStable(page)
    await toggleDiffStyle(page, { settle: "video" })
    await waitForReviewStable(page)
  })
  const lineCommentMs = await measureInPageReviewLineClick(page)
  await showChangesNavigator(page, fixture)
  const changedFileNavMs = await measureChangedFileNavigation(page, fixture.changedFiles[1]?.file ?? fixture.changedFiles[0]!.file)
  return {
    headline,
    debug: [
      lower("review_panel_open_ms", reviewPanelOpenMs),
      lower("vcs_load_ms", vcsLoadMs),
      lower("hunk_render_ms", hunkRenderMs),
      lower("line_comment_ms", lineCommentMs),
      lower("changed_file_navigation_ms", changedFileNavMs),
    ],
  }
}

async function workspaceSwitch(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  await launchTo(page, app, sessionPath(fixture.sessions[0]!, fixture.sessions[0]!.id))
  await waitForTranscript(page, fixture, fixture.sessions[0]!.id, fixture.sessions[0]!.title)
  const target = fixture.sessions.find((session) => session.directory !== fixture.sessions[0]!.directory) ?? fixture.sessions[1]!
  await showWorkspaceInventory(page, fixture, { settle: "frame" })
  // Headline: switching to another workspace and into one of its sessions.
  const headline = await measureInteraction(page, "workspace-switch", async () => {
    await clickWorkspace(page, fixture, target.directory, { settle: "frame" })
    await clickVisibleSession(page, fixture, target, { settle: "frame" })
    await waitForTranscript(page, fixture, target.id, target.title)
  })
  const files = await measureWorkspaceFiles(page, fixture, { settle: "frame" })
  await settleForVideo(page)
  return { headline, debug: files }
}

async function threePaneResize(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  await launchTo(page, app, sessionPath(fixture.sessions[0]!, fixture.sessions[0]!.id))
  await waitForTranscript(page, fixture, fixture.sessions[0]!.id, fixture.sessions[0]!.title)
  await openTerminalSurface(page, fixture)
  await openReviewSurface(page, fixture)
  await waitForReviewStable(page)
  // Headline: drag the real pane divider back and forth — the canonical layout jank.
  // This redistributes pane widths (NOT a browser-window resize), so the frames we
  // sample are the app's actual relayout work, and the video shows the divider move.
  let drag = { ms: 0, movedPx: 0 }
  const headline = await measureInteraction(page, "three-pane-resize", async () => {
    drag = await dragPaneDivider(page, fixture)
  })
  await settleForVideo(page)
  return {
    headline,
    debug: [
      lower("divider_drag_ms", Math.round(drag.ms * 100) / 100),
      lower("divider_moved_px", Math.round(drag.movedPx), "px"),
    ],
  }
}

// Drive a real pointer drag on a pane divider (content↔review separator, or the
// sidebar resize handle as a fallback) and SELF-VERIFY it actually moved the panes:
// if the divider's x-position doesn't change, the flow is faking a resize and we
// fail it. Returns the wall-clock of the drag.
async function dragPaneDivider(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  // The content↔review divider (the workspace-panel separator) is the meaningful
  // three-pane handle. Fall back to the generic layout resize-handle only if it's
  // absent. We pin to the specific element so the self-check reads the same handle.
  const selector = '[role="separator"][aria-label="Resize workspace panel"]'
  const fallback = '[data-component="resize-handle"][data-direction="horizontal"]'
  const handle = page.locator(selector).first()
  const useSelector = (await handle.isVisible({ timeout: 5_000 }).catch(() => false)) ? selector : fallback
  const target = page.locator(useSelector).first()
  if (!(await target.isVisible({ timeout: 2_000 }).catch(() => false))) {
    recordVisualFailure(fixture, "no pane divider was visible to resize")
    return { ms: 0, movedPx: 0 }
  }
  const before = await target.boundingBox()
  if (!before) {
    recordVisualFailure(fixture, "pane divider had no bounding box")
    return { ms: 0, movedPx: 0 }
  }
  const cx = before.x + before.width / 2
  const cy = before.y + before.height / 2
  const dividerX = () =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel)
      return el ? el.getBoundingClientRect().x : -1
    }, useSelector)

  const started = performance.now()
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  // Paced sweep (~1s round trip) so the divider visibly tracks on the video and each
  // relayout frame is sampled. The wait between steps is the human cadence of a drag.
  for (let offset = 15; offset <= 180; offset += 15) {
    await page.mouse.move(cx - offset, cy)
    await page.waitForTimeout(25)
  }
  const midDragX = await dividerX() // divider should now sit ~180px left of where we grabbed it
  for (let offset = 180; offset >= 0; offset -= 15) {
    await page.mouse.move(cx - offset, cy)
    await page.waitForTimeout(25)
  }
  await page.mouse.up()
  const ms = performance.now() - started
  const movedPx = midDragX < 0 ? 0 : Math.abs(midDragX - before.x)
  // Anti-theater self-check: if the divider didn't actually move, the flow is faking
  // a resize — fail it loudly instead of reporting jank for an interaction that never
  // happened. `divider_moved_px` in the debug output is the hard proof it resized.
  if (movedPx < 40) {
    recordVisualFailure(fixture, `pane divider did not move during drag (x ${Math.round(before.x)} → ${Math.round(midDragX)})`)
  }
  return { ms, movedPx }
}

async function launchTo(page: Page, app: BrowserTarget, pathName: string) {
  const started = performance.now()
  await page.goto(`${app.baseUrl}${pathName}`, { waitUntil: "domcontentloaded" })
  const domContentLoaded = performance.now() - started
  await waitForUsefulScreen(page)
  const useful = performance.now() - started
  await waitForLaunchStable(page)
  const ready = performance.now() - started
  return { domContentLoaded, useful, ready }
}

async function waitForLaunchStable(page: Page) {
  await page.evaluate(() =>
    new Promise<void>((resolve) => {
      const ready = document.fonts?.ready?.catch(() => undefined) ?? Promise.resolve()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            void ready.then(() => resolve())
          })
        })
      })
    }),
  )
}

async function installSeedState(page: Page, target: AppTarget, fixture: ReturnType<typeof fixtureFor>) {
  await page.addInitScript(({ target, directory, project, sessions, claxedoState }) => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { showFileTree: true, showSessionProgressBar: true, editToolPartsExpanded: true } }),
    )
    localStorage.setItem(
      "opencode.global.dat:layout",
      JSON.stringify({
        sidebar: { opened: true, width: 280, workspaces: {}, workspacesDefault: true },
        terminal: { height: 320, opened: false },
        review: { diffStyle: "split", panelOpened: true },
        fileTree: { opened: true, width: 280, tab: "changes" },
        session: { width: 600 },
        mobileSidebar: { opened: false },
        sessionTabs: {},
        sessionView: {},
        handoff: {},
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
    localStorage.setItem("claxedo.state.v5", JSON.stringify(claxedoState))
    if (target === "claxedo") {
      const win = window as typeof window & {
        __CLAXEDO_TEST_AUTH_TOKEN__?: string
        __CLAXEDO_TEST_AUTH_USER__?: unknown
      }
      win.__CLAXEDO_TEST_AUTH_TOKEN__ = "perf-browser-token"
      win.__CLAXEDO_TEST_AUTH_USER__ = { id: "perf-browser-user" }
    }
    sessionStorage.setItem("claxedo.perf.fixture", JSON.stringify({ project, sessions }))
  }, { target, directory: fixture.directory, project: fixture.project, sessions: fixture.sessions, claxedoState: claxedoStateSeed(fixture) })
}

export function claxedoStateSeed(fixture: Pick<ReturnType<typeof fixtureFor>, "directory" | "terminals">) {
  const metas = Object.fromEntries(
    fixture.terminals.map((terminal, index) => {
      const id = `terminal_perf_${index}`
      return [
        id,
        {
          id,
          type: "terminal",
          scope: "directory",
          directory: fixture.directory,
          terminalId: terminal.id,
          content: {
            type: "terminal",
            directory: fixture.directory,
            terminalId: terminal.id,
            title: terminal.title,
          },
        },
      ]
    }),
  )
  const contentIds = Object.keys(metas)
  return {
    workbench: {
      panes: [],
      split: { direction: "h", sizes: [] },
      contentIds,
      contentRecency: [...contentIds].reverse(),
      focusedPaneId: null,
      layoutSnapshots: {},
    },
    meta: metas,
    rail: { collapsed: false, hovered: false, pinned: true, locked: false },
    workspace: { paneWorktree: {}, recency: {}, worktreeColor: {} },
    workspacePanel: {
      open: false,
      mode: "navigator",
      workspaceDir: fixture.directory,
      targetPaneId: null,
      navigator: { search: "", selectedId: null },
    },
    terminal: {
      owner: Object.fromEntries(fixture.terminals.map((terminal, index) => [terminal.id, `terminal_perf_${index}`])),
      agentStatus: Object.fromEntries(fixture.terminals.map((terminal) => [terminal.id, "idle"])),
      agentSeen: {},
      lifecycle: Object.fromEntries(fixture.terminals.map((terminal) => [terminal.id, "attached"])),
    },
    processPane: { crashedWhileClosed: false, pendingAction: null },
  }
}

async function installMockApi(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (!shouldMock(url, app)) return route.fallback()
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: mockCorsHeaders(route),
      })
    }
    const body = responseFor(url, fixture)
    if (body === undefined) return route.fallback()
    if (body === "event-stream") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", headers: mockCorsHeaders(route), body: ": perf\n\n" })
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: mockCorsHeaders(route),
      body: JSON.stringify(body),
    })
  })
}

function mockCorsHeaders(route: Route) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": route.request().headers()["access-control-request-headers"] ?? "authorization, content-type",
    "access-control-expose-headers": "x-next-cursor",
  }
}

function shouldMock(url: URL, app: BrowserTarget) {
  if (url.port === String(app.mockPort)) return true
  if (url.origin === app.baseUrl && apiPath(url.pathname)) return true
  return false
}

function apiPath(pathName: string) {
  return [
    "/agent",
    "/api",
    "/auth",
    "/command",
    "/config",
    "/event",
    "/experimental",
    "/file",
    "/find",
    "/formatter",
    "/global",
    "/lsp",
    "/mcp",
    "/path",
    "/permission",
    "/project",
    "/provider",
    "/pty",
    "/question",
    "/session",
    "/skill",
    "/vcs",
    "/worktree",
  ].some((prefix) => pathName === prefix || pathName.startsWith(`${prefix}/`))
}

function responseFor(url: URL, fixture: ReturnType<typeof fixtureFor>): unknown {
  const pathName = url.pathname
  if (pathName === "/event" || pathName === "/global/event") return "event-stream"
  if (pathName === "/health") return { ok: true, healthy: true, version: "perf-browser" }
  if (pathName === "/global/health") return { healthy: true, version: "perf-browser" }
  if (pathName === "/experimental/session") return experimentalSessions(url, fixture)
  if (pathName === "/api/workspace") return { workspaces: controlWorkspaces(fixture) }
  if (pathName === "/api/control/sessions") return { sessions: controlSessions(fixture, url.searchParams.get("workspaceId")) }
  if (pathName === "/api/claxedo/diff/vcs") return changedFilesForVcs(url, fixture)
  if (pathName === "/api/claxedo/diff/vcs/file") return diffForFile(url, fixture)
  if (pathName === "/api/claxedo/diff/refs") return { branches: ["dev"], tags: [], recent: ["HEAD~1"] }
  if (pathName === "/api/claxedo/diff/targets") return { defaultRef: "dev", candidates: ["dev", "HEAD~1"] }
  if (pathName === "/api/claxedo/hook/terminal-session") return terminalSessionPreview(url, fixture)
  if (pathName === "/api/claxedo/pty") return fixture.terminals[0]
  if (pathName.startsWith("/api/claxedo/pty/")) return fixture.terminals[0] ?? {}
  if (pathName === "/api/claxedo/health") return { ok: true, healthy: true, version: "perf-browser" }
  if (pathName === "/api/claxedo/bootstrap") return boot(fixture)
  if (pathName === "/api/claxedo/agent-config/agents") return agents()
  if (pathName === "/api/claxedo/agent-config/commands") return commands()
  if (pathName === "/provider") return fixture.provider
  if (pathName === "/provider/auth") return {}
  if (pathName === "/path") return fixture.path
  if (pathName === "/project") return fixture.projects
  if (pathName === "/project/current") return fixture.project
  if (pathName === "/worktree") return fixture.workspaceDirectories.slice(1)
  if (pathName === "/global/config" || pathName === "/config") return {}
  if (pathName === "/agent") return agents()
  if (pathName === "/command") return commands()
  if (pathName === "/vcs") return { branch: "dev", default_branch: "dev" }
  if (pathName === "/vcs/status") return { branch: "dev", changed: fixture.changedFiles.slice(0, 50) }
  if (pathName === "/vcs/diff") return fixture.changedFiles
  if (pathName === "/session/status") return Object.fromEntries(fixture.sessions.map((session) => [session.id, { type: "idle" }]))
  if (pathName === "/session") return sessionsForDirectory(fixture, url.searchParams.get("directory"))
  if (["/skill", "/formatter", "/permission", "/question", "/lsp", "/mcp"].includes(pathName)) return []
  if (pathName === "/file/status") return fixture.changedFiles.map((item) => ({ path: item.file, status: item.status }))
  if (pathName === "/file/content") return fileContent(url, fixture)
  if (pathName === "/find/file") return searchFiles(url, fixture)
  if (pathName.startsWith("/file")) return fileNodes(url, fixture)
  if (pathName === "/pty") return fixture.terminals[0]
  if (pathName.startsWith("/pty")) return fixture.terminals[0] ?? {}

  const session = pathName.match(/^\/session\/([^/]+)$/)
  if (session) return fixture.sessions.find((item) => item.id === session[1]) ?? {}
  const sessionConfig = pathName.match(/^\/session\/([^/]+)\/config$/)
  if (sessionConfig) return configForSession(sessionConfig[1]!, fixture)
  if (/^\/session\/[^/]+\/diff$/.test(pathName)) return fixture.changedFiles
  if (/^\/session\/[^/]+\/(children|todo)$/.test(pathName)) return []
  if (/^\/session\/[^/]+\/capabilities$/.test(pathName)) return capabilities()

  const messages = pathName.match(/^\/session\/([^/]+)\/message$/)
  if (messages) {
    fixture.requestCounts.messages += 1
    fixture.requestCounts.messagesBySession[messages[1]!] = (fixture.requestCounts.messagesBySession[messages[1]!] ?? 0) + 1
    return pageMessages(messages[1]!, Number(url.searchParams.get("limit") ?? 80), url.searchParams.get("before") ?? undefined, fixture)
  }

  return {}
}

function diffForFile(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const file = url.searchParams.get("file")
  return fixture.changedFiles.find((item) => item.file === file) ?? fixture.changedFiles[0]
}

export function changedFilesForVcs(url: URL, fixture: Pick<ReturnType<typeof fixtureFor>, "changedFiles">) {
  if (url.searchParams.get("content") !== "summary") return fixture.changedFiles
  return fixture.changedFiles.map((item) => ({
    file: item.file,
    status: item.status,
    additions: item.additions,
    deletions: item.deletions,
  }))
}

function fileContent(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const file = url.searchParams.get("path") ?? fixture.changedFiles[0]?.file ?? "src/generated/file-0.ts"
  return `export const perfFile = ${JSON.stringify(file)}\n`
}

function searchFiles(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const query = (url.searchParams.get("query") ?? "").toLowerCase()
  return fixture.changedFiles
    .map((item) => item.file)
    .filter((file) => !query || file.toLowerCase().includes(query))
    .slice(0, Number(url.searchParams.get("limit") ?? 80))
}

function fileNodes(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const requested = normalizeFileTreePath(url.searchParams.get("path") ?? "")
  const files = fixture.changedFiles.map((item) => item.file)
  const children = new Map<string, { path: string; type: "file" | "directory" }>()
  for (const file of files) {
    const parts = file.split("/")
    const current = requested ? requested.split("/").filter(Boolean) : []
    if (current.some((part, index) => parts[index] !== part)) continue
    const next = parts[current.length]
    if (!next) continue
    const nextPath = [...current, next].join("/")
    children.set(nextPath, { path: nextPath, type: current.length === parts.length - 1 ? "file" : "directory" })
  }
  return [...children.values()].map((node) => ({
    type: node.type,
    path: node.path,
    name: path.basename(node.path),
  }))
}

function normalizeFileTreePath(value: string) {
  if (!value || value === "/") return ""
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "")
  const generatedIndex = normalized.indexOf("src/generated")
  if (generatedIndex !== -1) return normalized.slice(generatedIndex)
  const srcIndex = normalized.indexOf("src")
  if (srcIndex !== -1) return normalized.slice(srcIndex)
  return normalized.replace(/^\/+/, "")
}

function terminalSessionPreview(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const terminalId = url.searchParams.get("terminalId") ?? fixture.terminals[0]?.id ?? "pty_perf"
  return {
    success: true,
    terminalId,
    session: {
      terminalId,
      sessionId: fixture.sessions[0]?.id ?? null,
      workspaceId: fixture.directory,
      provider: "opencode",
      refName: "dev",
      prompt: "perf terminal",
      lastAssistantMessage: "Terminal benchmark session ready",
      eventType: "ready",
      updatedAt: 1_700_000_020_000,
    },
  }
}

function experimentalSessions(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const directory = url.searchParams.get("directory")
  if (url.searchParams.get("groupBy") === "workspace") {
    return {
      groups: fixture.workspaceDirectories.map((dir) => {
        const sessions = sessionsForDirectory(fixture, dir)
        return {
          directory: dir,
          projectID: fixture.project.id,
          sessions,
          hasMore: false,
          total: sessions.length,
          nextCursor: undefined,
        }
      }),
    }
  }
  return sessionsForDirectory(fixture, directory)
}

function sessionsForDirectory(fixture: ReturnType<typeof fixtureFor>, directory?: string | null) {
  if (!directory) return fixture.sessions
  return fixture.sessions.filter((session) => session.directory === directory)
}

function controlWorkspaces(fixture: ReturnType<typeof fixtureFor>) {
  return fixture.workspaceDirectories.map((directory, index) => ({
    id: `workspace_${index}`,
    workspace_id: `workspace_${index}`,
    project_id: fixture.project.id,
    worktree: directory,
    directory,
    name: workspaceLabel(fixture, directory),
    workspace_name: workspaceLabel(fixture, directory),
    access: "local",
    backing: "local",
    created_at: 1_700_000_000_000 + index,
    updated_at: 1_700_000_010_000 + index,
  }))
}

function controlSessions(fixture: ReturnType<typeof fixtureFor>, workspaceId?: string | null) {
  const index = workspaceId ? Number(workspaceId.replace(/^workspace_/, "")) : NaN
  const directory = Number.isFinite(index) ? fixture.workspaceDirectories[index] : undefined
  return sessionsForDirectory(fixture, directory).map((session) => ({
    id: session.id,
    sessionID: session.id,
    session_id: session.id,
    title: session.title,
    directory: session.directory,
    projectID: session.projectID,
    createdAt: session.time.created,
    updatedAt: session.time.updated,
    created_at: session.time.created,
    updated_at: session.time.updated,
  }))
}

function boot(fixture: ReturnType<typeof fixtureFor>) {
  return {
    healthy: true,
    version: "perf-browser",
    path: fixture.path,
    project: fixture.projects,
    provider: fixture.provider,
    provider_auth: {},
    config: {},
  }
}

function capabilities() {
  return {
    transport: "perf-browser",
    abort: true,
    reconnect: true,
    replay: true,
    permissions: true,
    questions: true,
    todos: true,
    fork: true,
    revert: true,
  }
}

function configForSession(sessionID: string, fixture: ReturnType<typeof fixtureFor>) {
  const session = fixture.sessions.find((item) => item.id === sessionID)
  return {
    runner: { type: "opencode" },
    agent: "build",
    model: {
      providerID: "opencode",
      modelID: "claude-opus-4-6",
    },
    variant: null,
    ...(session ? { directory: session.directory } : {}),
  }
}

function fixtureFor(scenario: ScenarioId, seed: SeedManifest) {
  const directory = `/tmp/claxedo-perf/${scenario}`
  const workspaceDirectories = Array.from({ length: Math.max(1, seed.projects) }, (_, index) =>
    index === 0 ? directory : `${directory}/workspace-${index + 1}`,
  )
  const providerID = "opencode"
  const modelID = "claude-opus-4-6"
  const sessions = Array.from({ length: Math.max(2, seed.sessions || 1) }, (_, index) => ({
    id: `ses_perf_${scenario.replace(/-/g, "_")}_${index}`,
    slug: `perf-${index}`,
    projectID: `proj_perf_${scenario.replace(/-/g, "_")}`,
    directory: scenario === "workspace-switch" ? workspaceDirectories[index % workspaceDirectories.length]! : directory,
    title: `${scenario} session ${index + 1}`,
    version: "dev",
    time: { created: 1_700_000_000_000 + index, updated: 1_700_000_010_000 + index },
  }))
  const project = {
    id: `proj_perf_${scenario.replace(/-/g, "_")}`,
    worktree: directory,
    vcs: "git",
    name: scenario,
    time: { created: 1_700_000_000_000, updated: 1_700_000_010_000 },
    sandboxes: workspaceDirectories.slice(1),
    workspaces: Object.fromEntries(workspaceDirectories.map((dir, index) => [
      dir,
      {
        kind: "local",
        workspace_name: index === 0 ? "main" : `workspace ${index + 1}`,
        available: true,
      },
    ])),
  }
  return {
    directory,
    workspaceDirectories,
    project,
    projects: [project],
    path: { state: directory, config: directory, worktree: directory, directory, home: "/tmp" },
    provider: {
      all: [
        {
          id: providerID,
          name: "OpenCode",
          source: "api",
          env: [],
          options: {},
          models: {
            [modelID]: {
              id: modelID,
              providerID,
              name: "Claude Opus 4.6",
              family: "claude-4",
              release_date: "2026-01-01",
              attachment: true,
              reasoning: true,
              temperature: true,
              tool_call: true,
              limit: { context: 200_000, output: 64_000 },
              options: {},
              cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
              status: "active",
            },
          },
        },
      ],
      connected: [providerID],
      default: { [providerID]: modelID },
    },
    sessions,
    changedFiles: Array.from({ length: Math.max(1, seed.changed_files) }, (_, index) => ({
      file: `src/generated/file-${index}.ts`,
      status: index % 11 === 0 ? "added" : "modified",
      additions: (index % 9) + 1,
      deletions: index % 3,
      patch: `@@ -1 +1 @@\n-export const value = ${index}\n+export const value = ${index + 1}`,
    })),
    terminals: Array.from({ length: Math.max(1, seed.terminals || 1) }, (_, index) => ({
      id: `pty_perf_${scenario.replace(/-/g, "_")}_${index}`,
      title: `Terminal ${index + 1}`,
    })),
    totalMessages: Math.max(12, seed.messages || 12),
    requestCounts: {
      messages: 0,
      messagesBySession: {} as Record<string, number>,
      expectedTranscripts: {} as Record<string, string>,
      visibleTranscripts: {} as Record<string, boolean>,
    },
    visualFailures: [] as string[],
  }
}

function pageMessages(sessionID: string, limit: number, before: string | undefined, fixture: ReturnType<typeof fixtureFor>) {
  const end = before ? Math.max(0, Number(before.split("_").at(-1)) || fixture.totalMessages) : fixture.totalMessages
  const start = Math.max(0, end - limit)
  const sessionTitle = fixture.sessions.find((session) => session.id === sessionID)?.title
  const items = Array.from({ length: end - start }, (_, offset) =>
    message(sessionID, start + offset, fixture.directory, sessionTitle)
  )
  return items
}

function message(sessionID: string, index: number, directory: string, sessionTitle?: string) {
  const id = `msg_perf_${index}`
  const role = index % 2 === 0 ? "user" : "assistant"
  const model = { providerID: "opencode", modelID: "claude-opus-4-6" }
  const tokens = {
    input: 800 + index * 13,
    output: role === "assistant" ? 240 + index * 7 : 0,
    reasoning: role === "assistant" ? 32 : 0,
    cache: { read: index * 3, write: role === "assistant" ? 4 : 0 },
  }
  return {
    info: {
      id,
      sessionID,
      role,
      time: {
        created: 1_700_000_000_000 + index * 1000,
        ...(role === "assistant" ? { completed: 1_700_000_000_500 + index * 1000 } : {}),
      },
      agent: "build",
      ...(role === "user"
        ? { model }
        : {
            parentID: `msg_perf_${Math.max(0, index - 1)}`,
            path: { cwd: directory, root: directory },
            modelID: model.modelID,
            providerID: model.providerID,
            mode: "build",
            cost: Number((0.0025 + index * 0.0001).toFixed(4)),
            tokens,
          }),
    },
    parts: [
      {
        id: `part_perf_${index}`,
        sessionID,
        messageID: id,
        type: "text",
        text: `${role} message ${index}${sessionTitle ? ` for ${sessionTitle}` : ""}\n\n${"sample output ".repeat(40 + (index % 20))}`,
      },
    ],
  }
}

function commands() {
  return [
    { id: "terminal.new", title: "New terminal", category: "terminal" },
    { id: "review.toggle", title: "Toggle review", category: "view" },
    { id: "theme.toggle", title: "Toggle theme", category: "view" },
  ]
}

function agents() {
  return [{ name: "build", mode: "primary" }]
}

function sessionPath(fixture: { directory: string }, sessionId: string) {
  return `/s/${sessionId}`
}

function workspacePath(directory: string) {
  return `/${base64Encode(directory)}`
}

function base64Encode(value: string) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function startApp(): Promise<BrowserTarget> {
  const basePort = await freePort()
  const mockPort = Number(process.env.CLAXEDO_PERF_MOCK_PORT) || await freePort()
  const baseUrl = `http://127.0.0.1:${basePort}`
  const script = process.env.CLAXEDO_PERF_APP_SCRIPT ?? "dev"
  const cmd = script === "serve"
    ? ["node", "./node_modules/vite/bin/vite.js", "preview", "--config", "vite.cloud.config.ts", "--host", "127.0.0.1", "--port", String(basePort)]
    : ["bun", "run", script, "--", "--host", "127.0.0.1", "--port", String(basePort)]
  const command = cmd.join(" ")
  const proc = Bun.spawn({
    cmd,
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: String(basePort),
      PLAYWRIGHT_PORT: String(basePort),
      PLAYWRIGHT_SERVER_HOST: "127.0.0.1",
      PLAYWRIGHT_SERVER_PORT: String(mockPort),
      VITE_OPENCODE_SERVER_HOST: "127.0.0.1",
      VITE_OPENCODE_SERVER_PORT: String(mockPort),
      VITE_OPENCODE_BACKEND_URL: `http://127.0.0.1:${mockPort}`,
      VITE_CLAXEDO_SERVER_URL: `http://127.0.0.1:${mockPort}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  void drain(proc.stdout)
  void drain(proc.stderr)
  await waitForServer(baseUrl, proc)
  return { target: app.id, baseUrl, mockPort, command, process: proc }
}

async function stopApp(app: BrowserTarget) {
  app.process?.kill()
  await app.process?.exited.catch(() => undefined)
}

async function waitForServer(url: string, process: Bun.Subprocess) {
  const started = Date.now()
  while (Date.now() - started < 120_000) {
    if (process.exitCode !== null) throw new Error(`App dev server exited before becoming ready: ${url}`)
    const ok = await fetch(url).then(() => true).catch(() => false)
    if (ok) return
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for app dev server: ${url}`)
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port")))
    })
    server.on("error", reject)
  })
}

async function drain(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return
  for await (const _ of stream) {
  }
}

async function closeContextAndSaveVideo(
  context: BrowserContext,
  page: Page,
  target: AppTarget,
  scenario: ScenarioId,
  iteration: number,
) {
  const video = page.video()
  await context.close()
  const raw = video ? await video.path().catch(() => undefined) : undefined
  if (!raw) return undefined
  const dir = path.join(reportsRoot, "videos")
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${target}-${scenario}-${iteration + 1}.webm`)
  await rename(raw, file).catch(async () => {
    await Bun.write(file, Bun.file(raw))
  })
  return file
}

function lower(metric: string, value: number, unit = "ms"): Measurement {
  return { metric, value, unit, direction: "lower", samples: [value] }
}

function monitorPage(page: Page) {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  page.on("pageerror", (error) => {
    pageErrors.push(error.message)
  })
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  return { pageErrors, consoleErrors, failedResponses }
}

async function validationFailures(
  page: Page,
  monitor: ReturnType<typeof monitorPage>,
  scenario: ScenarioId,
  fixture: ReturnType<typeof fixtureFor>,
) {
  const text = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "")
  return [
    ...monitor.pageErrors.map((error) => `page error: ${error}`),
    ...monitor.consoleErrors.filter(significantConsoleError).map((error) => `console error: ${error}`),
    ...(text.includes("Something went wrong") || text.includes("An error occurred while loading the application")
      ? [`error boundary rendered for ${scenario}`]
      : []),
    ...(!text.trim() ? [`blank page rendered for ${scenario}`] : []),
    ...(missingSessionMessageRequest(scenario, fixture) ? [`session messages were not requested for ${scenario}`] : []),
    ...(sessionScenario(scenario) && loadingOnly(text) ? [`session page was still loading for ${scenario}`] : []),
    ...(sessionScenario(scenario) && text.includes("Model unavailable") ? [`composer model was unavailable for ${scenario}`] : []),
    ...(sessionScenario(scenario) && text.includes("Select agent") ? [`composer agent was unavailable for ${scenario}`] : []),
    ...fixture.visualFailures,
    ...Object.entries(fixture.requestCounts.expectedTranscripts).flatMap(([sessionID, expected]) =>
      fixture.requestCounts.visibleTranscripts[sessionID] ? [] : [`transcript text was not visible for ${scenario}: ${expected}`],
    ),
  ].filter((failure, index, failures) => failures.indexOf(failure) === index)
}

function significantConsoleError(text: string) {
  return ["Cannot read properties", "ReferenceError", "TypeError", "Uncaught", "Something went wrong"].some((needle) => text.includes(needle))
}

function loadingOnly(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized === "Loading..." || normalized === "Loading" || normalized.endsWith(" Loading...")
}

function sessionScenario(scenario: ScenarioId) {
  // Flows that don't navigate into a specific session — the harness shouldn't
  // fail them on "session messages were not requested". Only the empty-home
  // launch qualifies; every other flow opens a session.
  return scenario !== "launch-empty-home"
}

export function missingSessionMessageRequest(scenario: ScenarioId, fixture: SessionRequestCountsForValidation) {
  if (!sessionScenario(scenario)) return false
  if (fixture.requestCounts.messages > 0) return false
  const expected = Object.keys(fixture.requestCounts.expectedTranscripts)
  if (expected.length === 0) return true
  return expected.every((sessionID) => !fixture.requestCounts.visibleTranscripts[sessionID])
}

async function waitForUsefulScreen(page: Page) {
  await page.waitForFunction(() => {
    if (document.body?.innerText.trim()) return true
    const root = document.querySelector("#root") ?? document.body
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden"
    }
    return Array.from(root.querySelectorAll("button, input, textarea, [role], [data-component], [data-testid], a, main, aside, nav"))
      .some(visible)
  }, undefined, { timeout: 30_000 })
}

async function waitForTranscript(page: Page, fixture: ReturnType<typeof fixtureFor>, sessionID: string, text: string) {
  fixture.requestCounts.expectedTranscripts[sessionID] = text
  const visible = await page.waitForFunction(({ id, expected }) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-testid='session-page-root'], [data-testid='session-content']"))
      .some((node) => {
        if (node.dataset.sessionId !== id) return false
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        return (node.textContent ?? "").includes(expected)
      }),
    { id: sessionID, expected: text },
    { timeout: 10_000 },
  ).then(() => true).catch(() => false)
  if (visible) {
    fixture.requestCounts.visibleTranscripts[sessionID] = true
    return
  }
  const ready = await page.waitForFunction((id) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-testid='session-page-root'], [data-testid='session-content']"))
      .some((node) => {
        if (node.dataset.sessionId !== id) return false
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        if (node.dataset.sessionMessagesReady === "false") return false
        const messageCount = Number(node.dataset.sessionMessageCount ?? node.dataset.sessionConversationCount ?? "0")
        return !Number.isFinite(messageCount) || messageCount > 0
      }),
    sessionID,
    { timeout: 10_000 },
  ).then(() => true).catch(() => false)
  if (ready) {
    fixture.requestCounts.visibleTranscripts[sessionID] = true
    return
  }
}

async function waitForSessionSurface(page: Page, sessionID: string, title: string) {
  await page.waitForFunction(({ id, expected }) => {
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    return Array.from(document.querySelectorAll<HTMLElement>(
      "[data-testid='session-page-root'], [data-testid='session-content'], main, [role='main']",
    )).some((node) => {
      if (!visible(node)) return false
      if (node.dataset.sessionId && node.dataset.sessionId !== id) return false
      return (node.textContent ?? "").includes(expected)
    })
  }, { id: sessionID, expected: title }, { timeout: 10_000 }).catch(() => undefined)
}

async function showSessionInventory(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  expected: number,
  options: { settle?: "video" | "frame" } = {},
) {
  if ((options.settle ?? "video") === "frame") {
    const found = await countTitlesInBody(page, fixture.sessions.slice(0, expected).map((session) => session.title))
    if (found < expected) {
      recordVisualFailure(fixture, `only ${found} of ${expected} seeded sessions were visible in the session inventory`)
    }
    return
  }
  await waitForText(page, fixture.sessions[0]?.title ?? "session", 10_000)
  const loadedMore = await clickLoadMoreUntil(page, fixture, expected)
  const found = await countTitlesInBody(page, fixture.sessions.slice(0, expected).map((session) => session.title))
  if (found < expected) {
    recordVisualFailure(fixture, `only ${found} of ${expected} seeded sessions were visible in the session inventory`)
  }
  for (const session of fixture.sessions.slice(0, expected)) {
    const row = await sessionLocator(page, session)
    if (await row.isVisible({ timeout: 200 }).catch(() => false)) {
      await row.scrollIntoViewIfNeeded().catch(() => undefined)
      await waitForAnimationFrame(page, 1)
    }
  }
  if ((options.settle ?? "video") === "video") await settleForVideo(page)
  else await waitForAnimationFrame(page, 1)
}

async function clickVisibleSession(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  session: ReturnType<typeof fixtureFor>["sessions"][number],
  options: { settle?: "video" | "frame" } = {},
) {
  const settle = options.settle ?? "video"
  const row = await sessionLocator(page, session)
  if (await row.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await row.scrollIntoViewIfNeeded().catch(() => undefined)
    if (settle === "video") await settleForVideo(page)
    else await waitForAnimationFrame(page, 1)
    await row.click({ timeout: 5_000 })
    if (settle === "video") await settleForVideo(page)
    else await waitForAnimationFrame(page, 2)
    return
  }
  await page.goto(`${new URL(page.url()).origin}${sessionPath(session, session.id)}`, { waitUntil: "domcontentloaded" })
  const visibleOutcome = page.url().includes(`/s/${session.id}`) || page.url().includes(`/session/${session.id}`)
    || await page.getByText(session.title, { exact: false }).first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false)
  if (!visibleOutcome) recordVisualFailure(fixture, `session row was not clickable in the visible UI: ${session.title}`)
}

async function measureInPageSessionFirstFoldSwitch(page: Page, session: ReturnType<typeof fixtureFor>["sessions"][number]) {
  const result = await page.evaluate(async ({ id, title, debug }) => {
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden"
    }
    const row = document.querySelector<HTMLElement>(
      `[data-testid="rail-sidebar-session-row"][data-session-id="${CSS.escape(id)}"]`,
    ) ?? Array.from(document.querySelectorAll<HTMLElement>("[role='button'], button, a"))
      .find((node) => visible(node) && (node.textContent ?? "").includes(title))
    if (!row) return { ms: 10_000, debug: undefined }
    const beforeRoot = document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`)
    const beforeContent = document.querySelector<HTMLElement>(`[data-testid="session-content"][data-session-id="${CSS.escape(id)}"]`)
    row.scrollIntoView({ block: "nearest" })
    const started = performance.now()
    row.click()
    const ms = await new Promise<number>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - started
        const content = document.querySelector<HTMLElement>(
          `[data-testid="session-content"][data-session-id="${CSS.escape(id)}"], [data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`,
        )
        const targetRoot = document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`)
        const readyMessages = targetRoot?.dataset.sessionMessagesReady !== "false" &&
          Number(targetRoot?.dataset.sessionMessageCount ?? targetRoot?.dataset.sessionConversationCount ?? "0") > 0
        if (content && visible(content) && readyMessages) {
          resolve(performance.now() - started)
          return
        }
        if (elapsed > 10_000) {
          resolve(elapsed)
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const afterRoot = document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`)
    return {
      ms,
      debug: debug
        ? {
            hadBeforeRoot: !!beforeRoot,
            hadBeforeContent: !!beforeContent,
            beforeReady: beforeRoot?.dataset.sessionMessagesReady,
            beforeCount: beforeRoot?.dataset.sessionMessageCount,
            afterReady: afterRoot?.dataset.sessionMessagesReady,
            afterCount: afterRoot?.dataset.sessionMessageCount,
          }
        : undefined,
    }
  }, { id: session.id, title: session.title, debug: Bun.env.CLAXEDO_PERF_DEBUG_SESSION_SWITCH === "1" })
  if (result.debug) console.log("first-fold-switch-debug", JSON.stringify(result.debug))
  return result.ms
}

async function sessionLocator(page: Page, session: ReturnType<typeof fixtureFor>["sessions"][number]) {
  const link = page.locator(`a[href="${sessionPath(session, session.id)}"]`).first()
  if (await link.count().catch(() => 0)) return link
  const canonicalLink = page.locator(`a[href="/s/${session.id}"]`).first()
  if (await canonicalLink.count().catch(() => 0)) return canonicalLink
  const sessionLink = page.locator(`a[href*="/session/${session.id}"]`).first()
  if (await sessionLink.count().catch(() => 0)) return sessionLink
  const button = page.getByRole("button", { name: new RegExp(`${escapeRegExp(session.title)}(?!\\d)`, "i") }).first()
  if (await button.count().catch(() => 0)) return button
  return page.getByText(session.title, { exact: true }).first()
}

async function clickLoadMoreUntil(page: Page, fixture: ReturnType<typeof fixtureFor>, expected: number) {
  let clicked = false
  for (let index = 0; index < 8; index++) {
    const found = await countTitlesInBody(page, fixture.sessions.slice(0, expected).map((session) => session.title))
    if (found >= expected) return clicked
    const more = page.getByRole("button", { name: /load more/i }).first()
    if (!(await more.isVisible({ timeout: 500 }).catch(() => false))) return clicked
    await more.scrollIntoViewIfNeeded().catch(() => undefined)
    await more.click()
    clicked = true
    await settleForVideo(page)
  }
  return clicked
}

async function showWorkspaceInventory(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  options: { settle?: "video" | "frame" } = {},
) {
  if ((options.settle ?? "video") === "frame") {
    const missing = await page.evaluate((workspaces) => {
      const visible = (el: Element) => {
        if (el.closest("[aria-hidden='true']")) return false
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < innerHeight &&
          rect.left < innerWidth &&
          style.display !== "none" &&
          style.visibility !== "hidden"
      }
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        "[data-workspace-id], [data-workspace], [data-testid='workspace-header'], a, button, [role='button']",
      ))
      return workspaces.filter((workspace) => !candidates.some((el) => {
        if (!visible(el)) return false
        if (el.getAttribute("data-workspace-id") === workspace.directory) return true
        if (el.getAttribute("data-workspace") === workspace.encoded) return true
        const text = el.textContent ?? ""
        return text.includes(workspace.label) || text.includes(workspace.basename)
      })).map((workspace) => workspace.label)
    }, fixture.workspaceDirectories.map((directory) => ({
      directory,
      encoded: base64Encode(directory),
      label: workspaceLabel(fixture, directory),
      basename: path.basename(directory),
    }))).catch(() => fixture.workspaceDirectories.map((directory) => workspaceLabel(fixture, directory)))
    for (const label of missing) recordVisualFailure(fixture, `workspace was not visible in the sidebar: ${label}`)
    return
  }
  for (const directory of fixture.workspaceDirectories) {
    const label = workspaceLabel(fixture, directory)
    const visible = await findWorkspaceLocator(page, fixture, directory).isVisible({ timeout: 2_000 }).catch(() => false)
    if (!visible) recordVisualFailure(fixture, `workspace was not visible in the sidebar: ${label}`)
  }
  if ((options.settle ?? "video") === "video") await settleForVideo(page)
  else await waitForAnimationFrame(page, 1)
}

async function clickWorkspace(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  directory: string,
  options: { settle?: "video" | "frame" } = {},
) {
  const settle = options.settle ?? "video"
  const item = findWorkspaceLocator(page, fixture, directory)
  if (await item.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await item.scrollIntoViewIfNeeded().catch(() => undefined)
    if (settle === "video") await settleForVideo(page)
    else await waitForAnimationFrame(page, 1)
    await item.click({ timeout: 5_000 })
    if (settle === "video") await settleForVideo(page)
    else await waitForAnimationFrame(page, 2)
    return
  }
  recordVisualFailure(fixture, `workspace was not clickable in the visible UI: ${workspaceLabel(fixture, directory)}`)
}

function findWorkspaceLocator(page: Page, fixture: ReturnType<typeof fixtureFor>, directory: string) {
  return page
    .locator(`[data-workspace-id="${directory}"], [data-testid="workspace-header"][data-workspace-id="${directory}"]`)
    .or(page.locator(`[data-workspace="${base64Encode(directory)}"]`))
    .or(page.getByText(workspaceLabel(fixture, directory), { exact: false }))
    .or(page.getByText(path.basename(directory), { exact: false }))
    .first()
}

async function measureWorkspaceFiles(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  options: { settle?: "video" | "frame" } = {},
) {
  const result = await page.evaluate(async () => {
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none"
    }
    const present = (root: Element | null | undefined): root is Element => !!root
    const clickButton = (label: string, roots: Array<Document | Element> = [document]) => {
      const seen = new Set<HTMLElement>()
      for (const root of roots) for (const el of Array.from(root.querySelectorAll<HTMLElement>(
        `button[aria-label='${label}'], [role='button'][aria-label='${label}']`,
      ))) {
        if (seen.has(el)) continue
        seen.add(el)
        if (!visible(el)) continue
        el.click()
        return true
      }
      return false
    }
    const waitForFrameUntil = async (condition: () => boolean, timeout: number) =>
      await new Promise<boolean>((resolve) => {
        const started = performance.now()
        const tick = () => {
          if (condition()) {
            resolve(true)
            return
          }
          if (performance.now() - started > timeout) {
            resolve(false)
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    const waitClickButton = async (label: string, timeout: number) =>
      await waitForFrameUntil(() => clickButton(label, workspacePanelControlRoots()), timeout)
    const workspacePanelShell = () =>
      document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const visibleByTestId = (testId: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid='${testId}']`)).filter(visible)
    const workspacePanelControlRoots = () =>
      [
        workspacePanelShell()?.querySelector("[data-testid='workspace-panel-l1-header']"),
        ...visibleByTestId("workbench-l2-header"),
        ...visibleByTestId("workspace-panel-floating-chrome"),
        workspacePanelShell(),
      ].filter(present)
    const clickWorkspacePanelToggle = () =>
      clickButton("Open workspace panel", [
        ...visibleByTestId("workspace-panel-floating-chrome"),
        workspacePanelShell()?.querySelector("[data-testid='workspace-panel-l1-header']"),
      ].filter(present))
    const fileNavigator = () =>
      document.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")
    const navigatorOpen = (navigator: HTMLElement) => {
      const overlay = navigator.closest<HTMLElement>("[data-testid='workspace-navigator-overlay']")
      if (!overlay) return visible(navigator)
      return overlay.getAttribute("data-open") === "true" && overlay.getAttribute("aria-hidden") !== "true"
    }
    const navigatorVisible = () => {
      const navigator = fileNavigator()
      if (!navigator) return false
      if (
        navigatorOpen(navigator) &&
        navigator.getAttribute("data-file-tree-shell-ready") === "true"
      ) return true
      if (!visible(navigator)) return false
      return !!navigator.querySelector("[data-component='filetree'] [data-file-tree-path], [data-component='filetree'] button, [data-component='filetree'] [data-file-tree-loading]")
    }
    const navigatorDataVisible = () => {
      const navigator = fileNavigator()
      if (!navigator) return false
      if (
        navigatorOpen(navigator) &&
        navigator.getAttribute("data-file-tree-data-ready") === "true"
      ) return true
      if (!visible(navigator)) return false
      return !!navigator.querySelector("[data-component='filetree'] [data-file-tree-path], [data-component='filetree'] button")
    }
    const started = performance.now()
    if (navigatorVisible()) return { ok: true, total: 0, control: 0, state: 0, frame: 0, data: navigatorDataVisible() ? 0 : Number.NaN }
    const controlStarted = performance.now()
    const openedFilesDirectly = clickButton("Open Files", workspacePanelControlRoots())
    if (!openedFilesDirectly && !workspacePanelShell()) {
      clickWorkspacePanelToggle()
      await waitForFrameUntil(() => !!workspacePanelShell(), 2_000)
    }
    if (!navigatorVisible() && !openedFilesDirectly) await waitClickButton("Open Files", 2_000)
    const control = performance.now() - controlStarted
    const stateStarted = performance.now()
    const ok = await waitForFrameUntil(navigatorVisible, 5_000)
    const state = performance.now() - stateStarted
    const total = performance.now() - started
    const dataStarted = performance.now()
    const hasData = await waitForFrameUntil(navigatorDataVisible, 5_000)
    const data = hasData ? performance.now() - dataStarted : Number.NaN
    return {
      ok,
      total,
      control,
      state,
      frame: total,
      data,
    }
  })
  if (!result.ok) recordVisualFailure(fixture, "workspace files navigator did not visibly render")
  if ((options.settle ?? "video") === "video") await settleForVideo(page)
  else await waitForAnimationFrame(page, 1)
  return [
    lower("file_tree_load_ms", result.total),
    lower("file_tree_control_ms", result.control),
    lower("file_tree_state_ms", result.state),
    lower("file_tree_first_frame_ms", result.frame),
    lower("file_tree_data_ms", result.data),
  ]
}

async function openTerminalSurface(page: Page, fixture: ReturnType<typeof fixtureFor>, terminalTitle?: string) {
  if (await clickTerminalInventoryRow(page, terminalTitle)) {
    await waitForTerminalSurface(page, fixture)
    return
  }

  const toggle = page
    .locator('[aria-label*="terminal" i], [title*="terminal" i]')
    .filter({ hasNotText: /close/i })
    .first()
  if (await toggle.isVisible({ timeout: 100 }).catch(() => false)) {
    await toggle.click()
  } else {
    await page.keyboard.press("Control+`")
  }
  await clickTerminalInventoryRow(page, terminalTitle)
  await waitForTerminalSurface(page, fixture)
}

async function clickTerminalInventoryRow(page: Page, terminalTitle?: string) {
  const row = terminalTitle
    ? page.locator("[data-testid='terminal-section'] [role='button']").filter({ hasText: terminalTitle }).first()
    : page.locator("[data-testid='terminal-section'] [role='button']").filter({ hasText: /terminal/i }).last()
  if (await row.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await row.scrollIntoViewIfNeeded().catch(() => undefined)
    await row.click({ timeout: 5_000 })
    return true
  }
  return false
}

async function waitForTerminalSurface(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const visible = await page
    .waitForFunction(() => {
      const fits = (rect: DOMRect) => rect.width > 100 && rect.height > 40
      const panels = document.querySelectorAll("#terminal-panel")
      for (const panel of panels) {
        if (fits(panel.getBoundingClientRect())) return true
      }
      const candidates: NodeListOf<Element> = document.querySelectorAll(
        "[data-component='terminal'], [data-testid='terminal-surface'], .terminal-pane-content",
      )
      for (const candidate of candidates) {
        if (fits(candidate.getBoundingClientRect())) return true
      }
      return false
    }, undefined, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (!visible) recordVisualFailure(fixture, "terminal surface did not visibly open")
}

async function openReviewSurface(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  options: { settle?: "video" | "frame"; validateChangedFiles?: boolean } = {},
) {
  await showReviewSurfaceShell(page, fixture, options)
  await waitForReviewPanel(page, fixture)
  if ((options.settle ?? "video") === "video") await settleForVideo(page)
  else await waitForAnimationFrame(page, 2)
  if (options.validateChangedFiles ?? true) await waitForReviewChangedFiles(page, fixture)
}

async function showReviewSurfaceShell(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  options: { settle?: "video" | "frame" } = {},
) {
  const openedByWorkspacePanelToggle = await clickVisibleReviewControl(page, /^open workspace panel$/i)
    || await clickVisibleReviewControl(page, /(review|diff|changed files)/i)
  if (!openedByWorkspacePanelToggle) {
    const viewport = page.viewportSize()
    if (viewport) {
      await page.mouse.click(viewport.width - 16, 18)
      await waitForAnimationFrame(page, 2)
    }
    if (!await reviewPanelVisible(page, 1_000)) {
      await page.goto(`${new URL(page.url()).origin}${workspacePath(fixture.directory)}`, { waitUntil: "domcontentloaded" })
    }
  }
  await waitForWorkspacePanelShell(page, fixture)
  if ((options.settle ?? "video") === "video") await settleForVideo(page)
  else await waitForAnimationFrame(page, 1)
}

async function measureWorkspacePanelOpen(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const result = await page.evaluate(async () => {
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none"
    }
    const shellVisible = () => {
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      if (!shell || !visible(shell)) return false
      const rect = shell.getBoundingClientRect()
      return rect.width > 120 && rect.height > 120
    }
    const openWorkspacePanelControl = () => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(
        "button[aria-label='Open workspace panel'], [role='button'][aria-label='Open workspace panel']",
      ))) {
        if (!visible(el)) continue
        return el
      }
      return undefined
    }
    if (shellVisible()) return 0
    const control = openWorkspacePanelControl()
    if (!control) return undefined
    const started = performance.now()
    control.click()
    return await new Promise<number>((resolve) => {
      const limit = 5000
      const tick = () => {
        if (shellVisible() || performance.now() - started > limit) {
          resolve(performance.now() - started)
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })
  if (result !== undefined) {
    await waitForAnimationFrame(page, 2)
    return result
  }
  await showReviewSurfaceShell(page, fixture, { settle: "frame" })
  return 5000
}

async function clickVisibleReviewControl(page: Page, pattern: RegExp) {
  const target = await page.evaluate((source) => {
    const pattern = new RegExp(source, "i")
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden"
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("button, [role='button'], [aria-controls='review-panel']"))) {
      if (!visible(el)) continue
      const labels = [el.textContent, el.getAttribute("aria-label"), el.title]
        .map((label) => label?.trim())
        .filter((label): label is string => !!label)
      if (!labels.some((label) => pattern.test(label))) continue
      const rect = el.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    return undefined
  }, pattern.source)
  if (!target) return false
  await page.mouse.click(target.x, target.y)
  return true
}

async function waitForReviewSurface(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  await waitForReviewPanel(page, fixture)
  await waitForReviewChangedFiles(page, fixture)
}

async function waitForReviewPanel(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const visible = await reviewPanelVisible(page, 10_000)
  if (!visible) recordVisualFailure(fixture, "diff/review surface did not visibly open")
}

async function waitForWorkspacePanelShell(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const visible = await workspacePanelShellVisible(page, 5_000)
  if (!visible) recordVisualFailure(fixture, "workspace panel shell did not visibly open")
}

async function workspacePanelShellVisible(page: Page, timeout: number) {
  return await page
    .waitForFunction(() => {
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      const candidate = shell ?? document.querySelector<HTMLElement>(
        "#review-panel, [data-testid='review-pane-root'], [data-review-surface='workspace-review']",
      )
      if (!candidate || candidate.closest("[aria-hidden='true']")) return false
      const rect = candidate.getBoundingClientRect()
      return rect.width > 120 &&
        rect.height > 120 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth
    }, undefined, { timeout })
    .then(() => true)
    .catch(() => false)
}

async function reviewPanelVisible(page: Page, timeout: number) {
  return await page
    .waitForFunction(() => {
      const panels = document.querySelectorAll("#review-panel, [data-testid='review-pane-root'], [data-review-surface='workspace-review']")
      for (const panel of Array.from(panels)) {
        const rect = panel.getBoundingClientRect()
        const hiddenAncestor = panel.closest("[aria-hidden='true']")
        if (
          !hiddenAncestor &&
          rect.width > 120 &&
          rect.height > 120 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < innerHeight &&
          rect.left < innerWidth
        ) return true
      }
      return false
    }, undefined, { timeout })
    .then(() => true)
    .catch(() => false)
}

async function waitForReviewChangedFiles(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  options: { timeout?: number } = {},
) {
  const expectedFile = fixture.changedFiles[0]?.file ?? "file-0.ts"
  const fileVisible = await page
    .waitForFunction(
      ({ file, basename }) => document.body.innerText.includes(file) || document.body.innerText.includes(basename),
      { file: expectedFile, basename: path.basename(expectedFile) },
      { timeout: options.timeout ?? 10_000 },
    )
    .then(() => true)
    .catch(() => false)
  if (!fileVisible) recordVisualFailure(fixture, "diff/review surface did not visibly open with changed files")
}

async function measureReviewChangedFileReady(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  return await page.evaluate(async ({ file, basename }) => {
    const escape = globalThis.CSS?.escape ?? ((value: string) => value.replaceAll('"', '\\"'))
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return !el.closest("[aria-hidden='true']") &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden"
    }
    const ready = () => {
      const exact = document.querySelector<HTMLElement>(
        `[data-component="session-review"] [data-file="${escape(file)}"]`,
      )
      if (exact && visible(exact)) return true
      const review = document.querySelector<HTMLElement>("[data-component='session-review']")
      return !!review && review.textContent?.includes(basename)
    }
    if (ready()) return 0
    const started = performance.now()
    return await new Promise<number>((resolve) => {
      const limit = 2_000
      const tick = () => {
        const elapsed = performance.now() - started
        if (ready() || elapsed > limit) {
          resolve(elapsed)
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, {
    file: fixture.changedFiles[0]?.file ?? "file-0.ts",
    basename: path.basename(fixture.changedFiles[0]?.file ?? "file-0.ts"),
  })
}

async function scrollReview(page: Page, deltaY: number) {
  await moveMouseToReviewPanel(page)
  await wheelReview(page, deltaY)
}

async function moveMouseToReviewPanel(page: Page) {
  const box = await page.evaluate(() => {
    const panel = document.querySelector("#review-panel")
    const rect = panel?.getBoundingClientRect()
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined
  })
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

async function wheelReview(page: Page, deltaY: number) {
  await page.mouse.wheel(0, deltaY)
  await waitForAnimationFrame(page, 2)
}

async function measureInPageReviewScroll(page: Page, deltaY: number) {
  return await page.evaluate(async (delta) => {
    const viewport = document.querySelector<HTMLElement>(
      "#review-panel [data-slot='session-review-scroll'] .scroll-view__viewport",
    )
    if (!viewport) return 5000
    const startTop = viewport.scrollTop
    const targetTop = Math.min(viewport.scrollHeight - viewport.clientHeight, startTop + delta)
    if (targetTop <= startTop) return 0
    const started = performance.now()
    viewport.scrollTop = targetTop
    return await new Promise<number>((resolve) => {
      const limit = 1000
      const tick = () => {
        const elapsed = performance.now() - started
        if (viewport.scrollTop !== startTop) {
          requestAnimationFrame(() => resolve(performance.now() - started))
          return
        }
        if (elapsed > limit) {
          resolve(elapsed)
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, deltaY)
}

async function toggleDiffStyle(page: Page, options: { settle?: "video" | "frame" } = {}) {
  const settle = async () => {
    if ((options.settle ?? "video") === "video") await settleForVideo(page)
    else await waitForAnimationFrame(page, 2)
  }
  const clicked = await page.evaluate(() => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"))) {
      if (!visible(el)) continue
      if (!/(unified|split)/i.test(el.textContent ?? "")) continue
      el.click()
      return true
    }
    return false
  })
  if (!clicked) await page.keyboard.press("d")
  await settle()
}

async function measureInPageReviewLineClick(page: Page) {
  return await page.evaluate(async () => {
    const panel = document.querySelector("#review-panel")
    const panelRect = panel?.getBoundingClientRect()
    const lines = Array.from(document.querySelectorAll<HTMLElement>(
      "#review-panel [data-component='session-review'] [data-line]",
    ))
    let target: { x: number; y: number } | undefined
    for (const line of lines) {
      const rect = line.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue
      const x = Math.max(rect.left + 8, (panelRect?.left ?? rect.left) + 28)
      target = { x, y: rect.top + rect.height / 2 }
      break
    }
    if (!target && panelRect) {
      target = {
        x: panelRect.x + Math.min(96, panelRect.width / 4),
        y: panelRect.y + Math.min(220, panelRect.height / 2),
      }
    }
    if (!target) return 5000

    const element = document.elementFromPoint(target.x, target.y)
    const start = performance.now()
    element?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: target.x, clientY: target.y }))
    element?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, clientX: target.x, clientY: target.y }))
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, clientX: target.x, clientY: target.y }))
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve())
      })
    })
    return performance.now() - start
  })
}

async function waitForReviewStable(page: Page) {
  await page.evaluate(
    ({ frames, timeout }) =>
      new Promise<void>((resolve) => {
        const start = performance.now()
        let previous = ""
        let stable = 0
        const signature = () => {
          const panel = document.querySelector<HTMLElement>("#review-panel")
          if (!panel) return "missing"
          const rect = panel.getBoundingClientRect()
          const lines = Array.from(panel.querySelectorAll<HTMLElement>("[data-line]"))
          const visibleLines = lines
            .filter((line) => {
              const lineRect = line.getBoundingClientRect()
              return lineRect.width > 0 &&
                lineRect.height > 0 &&
                lineRect.bottom > 0 &&
                lineRect.right > 0 &&
                lineRect.top < innerHeight &&
                lineRect.left < innerWidth
            })
            .slice(0, 5)
            .map((line) => {
              const lineRect = line.getBoundingClientRect()
              return `${Math.round(lineRect.top)}:${Math.round(lineRect.height)}`
            })
          return [
            Math.round(rect.width),
            Math.round(rect.height),
            Math.round(panel.scrollTop),
            panel.querySelector("[data-review-diff-style]")?.getAttribute("data-review-diff-style") ?? "",
            lines.length,
            panel.querySelectorAll("[data-line-annotation]").length,
            visibleLines.join("|"),
          ].join(":")
        }
        const tick = () => {
          const next = signature()
          stable = next === previous ? stable + 1 : 0
          previous = next
          if (stable >= frames || performance.now() - start > timeout) {
            resolve()
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    { frames: 16, timeout: 2_000 },
  )
}

async function clickChangedFile(page: Page, file: string, options: { settle?: "video" | "frame" } = {}) {
  const clicked = await page.evaluate((targetFile) => {
    const escape = globalThis.CSS?.escape ?? ((value: string) => value.replaceAll('"', '\\"'))
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.contentVisibility !== "hidden"
    }
    const navigator = Array.from(document.querySelectorAll<HTMLElement>(
      '[data-testid="workspace-files-navigator"][data-mode="changes"]',
    )).find(visible)
    const target = navigator?.querySelector<HTMLElement>(`[data-file-tree-path="${escape(targetFile)}"]`)
    if (target && !visible(target)) target.scrollIntoView({ block: "nearest" })
    if (target && !visible(target)) return false
    target?.click()
    return !!target
  }, file)
  if (!clicked) {
    await page.keyboard.press("j")
  }
  if ((options.settle ?? "video") === "video") await settleForVideo(page)
  else await waitForAnimationFrame(page, 1)
}

async function showChangesNavigator(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const ok = await page.evaluate(async () => {
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none" &&
        style.contentVisibility !== "hidden"
    }
    const changesVisible = () =>
      Array.from(document.querySelectorAll<HTMLElement>(
        '[data-testid="workspace-files-navigator"][data-mode="changes"]',
      )).some(visible)
    if (changesVisible()) return true
    for (const button of Array.from(document.querySelectorAll<HTMLElement>(
      "button[aria-label='Open Changes'], [role='button'][aria-label='Open Changes']",
    ))) {
      if (!visible(button)) continue
      button.click()
      break
    }
    return await new Promise<boolean>((resolve) => {
      const started = performance.now()
      const tick = () => {
        if (changesVisible()) {
          resolve(true)
          return
        }
        if (performance.now() - started > 2_000) {
          resolve(false)
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })
  if (!ok) recordVisualFailure(fixture, "workspace changes navigator did not visibly render")
  await waitForAnimationFrame(page, 1)
}

async function measureChangedFileNavigation(page: Page, file: string) {
  return await page.evaluate(async (targetFile) => {
    const escape = globalThis.CSS?.escape ?? ((value: string) => value.replaceAll('"', '\\"'))
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.contentVisibility !== "hidden"
    }
    const navigator = Array.from(document.querySelectorAll<HTMLElement>(
      '[data-testid="workspace-files-navigator"][data-mode="changes"]',
    )).find(visible)
    const target = navigator?.querySelector<HTMLElement>(`[data-file-tree-path="${escape(targetFile)}"]`)
    if (target && !visible(target)) target.scrollIntoView({ block: "nearest" })
    if (!target || !visible(target)) return 5000

    const selected = () => {
      if (target.classList.contains("bg-surface-base-active")) return true
      const reviewNode = document.querySelector<HTMLElement>(
        `[data-component="session-review"] [data-file="${escape(targetFile)}"][data-selected]`,
      )
      return !!reviewNode && visible(reviewNode)
    }
    const started = performance.now()
    target.click()
    if (selected()) return performance.now() - started

    return await new Promise<number>((resolve) => {
      const limit = 1000
      const tick = () => {
        const elapsed = performance.now() - started
        if (selected() || elapsed > limit) {
          resolve(elapsed)
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, file)
}

async function waitForText(page: Page, text: string, timeout: number) {
  await page.waitForFunction(
    (expected) => document.body.textContent?.includes(expected) ?? false,
    text,
    { timeout },
  ).catch(() => undefined)
}

async function countTitlesInBody(page: Page, titles: string[]) {
  return await page.evaluate((titles) => {
    const text = document.body.textContent ?? ""
    return titles.filter((title) => text.includes(title)).length
  }, titles).catch(() => 0)
}

function recordVisualFailure(fixture: ReturnType<typeof fixtureFor>, message: string) {
  if (!fixture.visualFailures.includes(message)) fixture.visualFailures.push(message)
}

async function settleForVideo(page: Page) {
  await waitForAnimationFrame(page, 2)
  await page.waitForTimeout(250)
}

function workspaceLabel(fixture: ReturnType<typeof fixtureFor>, directory: string) {
  if (directory === fixture.directory) return "main"
  return fixture.project.workspaces[directory]?.workspace_name ?? path.basename(directory)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function focusFirstInput(page: Page) {
  const focused = await page.evaluate(() => {
    for (const selector of [
      "[data-component='session-new-design-text']",
      "[data-component='session-composer-text']",
      "textarea",
      "input",
      "[contenteditable=true]",
    ]) {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) continue
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none") continue
      element.focus()
      return true
    }
    return false
  })
  if (focused) return
  await page.mouse.click(20, 20)
}

async function scrollMain(page: Page, deltaY: number) {
  await page.mouse.wheel(0, deltaY)
  await waitForAnimationFrame(page, 2)
}

async function waitForAnimationFrame(page: Page, count: number) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const step = (remaining: number) => {
          if (remaining <= 0) {
            resolve()
            return
          }
          requestAnimationFrame(() => step(remaining - 1))
        }
        step(count)
      }),
    count,
  )
}
