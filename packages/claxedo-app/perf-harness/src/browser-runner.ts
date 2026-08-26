import { appendFileSync } from "node:fs"
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core"
import { runAttribution } from "./attribution"
import { flowName, type FlowResult } from "./flows"
import {
  frameSamplingLaunchArgs,
  installPageLoadRecorder,
  measureInteraction,
  mergeFrameMetrics,
  performanceMetricDelta,
  readDomMutationSnapshot,
  readPerformanceMetrics,
  stopPageLoadRecorder,
  type FrameMetric,
} from "./frame-sampler"
import { applyBudget, jsonReport, markdownReport } from "./report"
import { seedForScenario } from "./seed"
import { applyCpuProfile, applyNetworkProfile, environmentProfile, type EnvironmentProfile } from "./environment-profile"
import { installWebVitals, mergeWebVitals, readWebVitals, type WebVitals } from "./web-vitals"
import { browserRecords } from "./browser-records"
import { compareToBaseline, currentCommit, readBaselineFor, writeBaselineFor } from "./baseline-store"
import {
  HEAVY_WORKSPACE_CLOSE_DWELL_MS,
  HEAVY_WORKSPACE_EXPANDED_DIFF_LINES,
  HEAVY_WORKSPACE_REQUIRE_DISPOSAL_ENV,
  HEAVY_WORKSPACE_FILE_LINES,
  HEAVY_WORKSPACE_REOPEN_FILE_PATHS,
  HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR,
  heavyWorkspaceClosedOwnershipFailures,
  heavyWorkspaceInactiveFileOwnershipFailures,
  heavyWorkspaceInactiveReviewOwnershipFailures,
  heavyWorkspaceWindowedCorpusFailures,
  HEAVY_WORKSPACE_REVIEW_WINDOW_MAX_ROWS,
  HEAVY_WORKSPACE_REVIEW_WINDOW_SLACK,
  heavyWorkspaceExpansionRetentionFailures,
  heavyWorkspaceLiveFileFailures,
  heavyWorkspaceReviewRestorationFailures,
  heavyWorkspaceRestorationFailures,
  heavyWorkspaceSetupScrollFailures,
  type HeavyWorkspaceReviewIdentity,
  type HeavyWorkspaceSurfaceIdentity,
} from "./heavy-workspace-reopen-contract"
import {
  isolatedInteractionEvidenceFailures,
  isolatedInteractionMetricRows,
  isolatedInteractionResourceRequests,
  isolatedInteractionSettleFailures,
  ISOLATED_INTERACTION_TIMEOUT_MS,
  alreadyLoadedResourceRequestFailures,
  clickWarmupResourceRequestFailures,
  measureIsolatedInteraction,
  measurement,
  prepareTrustedInteraction,
  prepareTrustedWindowInteraction,
  settleBeforeNextInteraction,
  type IsolatedInteractionObservation,
} from "./isolated-interaction"
import {
  WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS,
  WORKSPACE_LIFECYCLE_DATA_FETCH_PATTERN,
  WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS,
  workspaceLifecycleAboveFoldFailures,
  workspaceLifecycleColdOpenFailures,
  workspaceLifecycleInterruptionFailures,
  workspaceLifecycleWarmReopenFailures,
  type WorkspaceLifecycleColdOpenObservation,
  type WorkspaceLifecycleInterruptionObservation,
  type WorkspaceLifecycleWarmReopenObservation,
} from "./workspace-lifecycle-contract"
import {
  WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX,
  WORKSPACE_INTERACTIONS_EXPAND_DIFF_LINES,
  WORKSPACE_INTERACTIONS_FILE_LINES,
  WORKSPACE_INTERACTIONS_HOVER_DWELL_MS,
  WORKSPACE_INTERACTIONS_LARGE_DIFF_INDEX,
  WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES,
  WORKSPACE_INTERACTIONS_LARGE_FILE_LINES,
  WORKSPACE_INTERACTIONS_LARGE_FILE_PATH,
  WORKSPACE_INTERACTIONS_OPEN_FILE_PATH,
  WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS,
  WORKSPACE_INTERACTIONS_RESIZE_DELTA_PX,
  workspaceInteractionCollapseFailures,
  workspaceInteractionDiffStyleFailures,
  workspaceInteractionExpandFailures,
  workspaceInteractionLargeDiffGuardFailures,
  workspaceInteractionNavigatorFailures,
  workspaceInteractionResizeFailures,
  workspaceInteractionTabDeltaFailures,
  workspaceInteractionTabSwitchFailures,
  type WorkspaceTabSnapshot,
} from "./workspace-interactions-contract"
import {
  RETAINED_PANEL_BODY_HOST_SELECTOR,
  RETAINED_PANEL_BODY_INERT_ATTRIBUTE,
  SESSION_SWITCH_SCOPES,
  SESSION_SWITCH_SUBSTANTIAL_FILE_PATH,
  SESSION_SWITCH_TEMPERATURES,
  crossWorkspaceSwitchClockFailures,
  sameWorkspaceSwitchStabilityFailures,
  sessionSwitchCellPrefix,
  sessionSwitchPenaltyMetricName,
  stabilityRequestClass,
  workspaceOpenPenaltyMs,
  type OldWorkspaceRelease,
  type SessionSwitchBlock,
  type SessionSwitchScope,
  type SessionSwitchTemperature,
  type StabilityRequestCounts,
} from "./session-switch-workspace-contract"
import {
  MockMessagePageError,
  parseMockMessagePageRequest,
  projectMockSurfacePage,
  selectMockMessagePage,
} from "./mock-message-page"
import { appendRunLog, runLogEntry } from "./run-log"
import { summarize } from "./stats"
import { appendTrend, appRoot, ensureBudget, harnessRoot, reportsRoot, writeBaseline, writeJson } from "./storage"
import { app } from "./targets"
import type {
  AppTarget,
  DiagnosticsOverheadEvidence,
  Measurement,
  RunOptions,
  ScenarioId,
  ScenarioResult,
  SeedManifest,
} from "./types"

export type BrowserTarget = {
  target: AppTarget
  baseUrl: string
  mockPort: number
  command: string
  process?: Bun.Subprocess
}

export type BrowserRun = Omit<ScenarioResult, "budget" | "status" | "failures" | "warnings"> & {
  validation_failures?: string[]
}

type SessionRenderer = "plain" | "markdown" | "code" | "mermaid" | "diff"

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

// Exported so the heavy-workspace contract test can pin its
// HEAVY_WORKSPACE_VIEWPORT_HEIGHT against the real benchmark window.
export const benchmarkViewport = { width: 1440, height: 960 }
export const diagnosticsPairModeOrder = [
  { label: "disabled control A", enabled: false },
  { label: "diagnostics enabled A", enabled: true },
  { label: "diagnostics enabled B", enabled: true },
  { label: "disabled control B", enabled: false },
] as const

export async function runBrowser(options: RunOptions) {
  const results: ScenarioResult[] = []
  const target = await startApp()
  const browsers: Browser[] = []
  try {
    browsers.push(await launchBenchmarkBrowser(options), await launchBenchmarkBrowser(options))
    for (const scenario of options.scenarios) {
      try {
        const modeRuns = []
        modeRuns.push(...await executeBrowserScenarioPair(
          options,
          target,
          scenario,
          browsers[0]!,
          diagnosticsPairModeOrder.slice(0, 2),
        ))
        modeRuns.push(...await executeBrowserScenarioPair(
          options,
          target,
          scenario,
          browsers[1]!,
          diagnosticsPairModeOrder.slice(2),
        ))
        const controls = modeRuns.filter((item) => !item.enabled)
        const enabled = modeRuns.filter((item) => item.enabled)
        const controlRun = mergeBrowserRuns(controls.map((item) => item.result.run))
        const enabledRun = mergeBrowserRuns(enabled.map((item) => item.result.run))
        const diagnostics = mergeDiagnosticsRuns(enabled.map((item) => {
          if (!item.result.diagnostics) {
            throw new Error(`${item.label} produced no profiler evidence`)
          }
          return item.result.diagnostics
        }))
        const measured = {
          ...enabledRun,
          diagnostics: {
            ...diagnostics,
            controlHeadline: controlRun.headline,
            enabledHeadline: enabledRun.headline,
          },
          attribution: runAttribution({
            browserVersion: enabled[0]!.result.browserVersion,
            server: { baseUrl: target.baseUrl, mockPort: target.mockPort, command: target.command },
          }),
        }
        const budget = await ensureBudget(measured)
        const budgeted = applyBudget(measured, budget)
        const validationFailures = modeRuns.flatMap((item) =>
          (item.result.run.validation_failures ?? []).map((failure) => `${item.label}: ${failure}`))
        const result = validationFailures.length === 0
          ? budgeted
          : {
              ...budgeted,
              status: "fail" as const,
              failures: [...budgeted.failures, ...validationFailures],
            }
        results.push(result)
        // Project onto the portable contract and compare against the tracked
        // baseline for THIS (profile, stack). Done here rather than in the
        // report so a run always leaves comparable evidence behind, whether or
        // not anyone reads the markdown.
        const records = browserRecords(result, options.stack)
        const baseline = await readBaselineFor({
          profile: records[0]!.profile, stack: options.stack, lane: "browser", flow: scenario,
        })
        result.comparison = compareToBaseline(records, baseline)
        if (options.accept_baseline) await writeBaselineFor(records, currentCommit())
        const entry = runLogEntry({
          records, comparison: result.comparison, commit: currentCommit(),
          at: result.started_at,
          evidence: {
            worstFrameMs: result.headline.worstFrameMs,
            framesOver1667: result.headline.framesOver1667,
            interactionCount: result.vitals?.interactionCount ?? 0,
          },
        })
        // The JSONL file is the web trend's data source. Attribution and CPU
        // profiling runs deliberately pass --no-trend because instrumentation
        // perturbs their timings, and failed readiness validation is not a
        // measurement at all. Neither belongs on the chart.
        if (entry && options.append_trend && validationFailures.length === 0) await appendRunLog(entry)
        console.log(`[perf] ${scenario}: ${result.status}`)
        if (options.update_baseline) await writeBaseline(result)
        if (options.append_trend) await appendTrend(result)
      } catch (error) {
        results.push(browserScenarioFailure({
          scenario,
          app: target,
          error,
        }))
      }
    }
  } finally {
    await Promise.all(browsers.map((browser) => closeBenchmarkBrowser(browser)))
    await stopApp(target)
  }

  const output = path.isAbsolute(options.output) ? options.output : path.join(reportsRoot, options.output)
  await writeJson(output, jsonReport(results))
  await Bun.write(output.replace(/\.json$/, ".md"), markdownReport(results, { debug: options.debug }))
  await writeJson(path.join(reportsRoot, "latest.json"), jsonReport(results))
  await Bun.write(path.join(reportsRoot, "latest.md"), markdownReport(results, { debug: options.debug }))
  return results
}

function launchBenchmarkBrowser(options: RunOptions) {
  return chromium.launch({
    headless: options.headless,
    args: frameSamplingLaunchArgs,
    timeout: 30_000,
  })
}

async function closeBenchmarkBrowser(browser: Browser) {
  if (!browser.isConnected()) return
  await Promise.race([
    browser.close().catch(() => undefined),
    Bun.sleep(10_000),
  ])
}

async function executeBrowserScenarioPair(
  options: RunOptions,
  target: BrowserTarget,
  scenario: ScenarioId,
  browser: Browser,
  modes: Array<(typeof diagnosticsPairModeOrder)[number]>,
) {
  const results = []
  for (const mode of modes) {
    console.log(`[perf] ${scenario}: ${mode.label}`)
    results.push({
      ...mode,
      result: await executeBrowserScenarioMode(options, target, scenario, browser, mode.enabled),
    })
  }
  return results
}

async function executeBrowserScenarioMode(
  options: RunOptions,
  target: BrowserTarget,
  scenario: ScenarioId,
  browser: Browser,
  diagnosticsEnabled: boolean,
) {
  let flowProfiler: Awaited<ReturnType<typeof startFlowProfiler>> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        if (diagnosticsEnabled) {
          flowProfiler = await startFlowProfiler(browser, scenario)
          // Interactive flows model the already-running desktop profiler. Let
          // its helper process and first steady collection finish before the
          // measured action; launch-project intentionally includes startup.
          if (scenario !== "launch-project") await Bun.sleep(2_250)
        }
        const rawRuns: BrowserRun[] = []
        for (let index = 0; index < options.iterations; index++) {
          rawRuns.push(await executeBrowserScenario(
            browser,
            target,
            scenario,
            diagnosticsEnabled ? options.iterations + index : index,
            environmentProfile(options.profile),
          ))
        }
        const run = mergeBrowserRuns(rawRuns)
        const diagnostics = flowProfiler ? await flowProfiler.stop() : undefined
        flowProfiler = undefined
        if (diagnosticsEnabled && !diagnostics) {
          throw new Error("Diagnostics-enabled flow produced no profiler evidence")
        }
        return {
          run,
          browserVersion: browser.version(),
          ...(diagnostics ? { diagnostics } : {}),
        } as {
          run: BrowserRun
          browserVersion: string
          diagnostics?: Omit<DiagnosticsOverheadEvidence, "controlHeadline" | "enabledHeadline">
        }
      })(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          reject(new Error(
            `Timed out running ${scenario} with diagnostics ${diagnosticsEnabled ? "enabled" : "disabled"}`,
          ))
        }, 120_000 * environmentProfile(options.profile).timeoutScale)
      }),
    ])
  } finally {
    if (deadline) clearTimeout(deadline)
    if (flowProfiler) await flowProfiler.stop().catch(() => undefined)
  }
}

async function startFlowProfiler(browser: Browser, scenario: ScenarioId) {
  const session = await browser.newBrowserCDPSession()
  const processInfo = await readBrowserProcessInfo(session)
  const rootPids = processInfo.processInfo
    .filter((entry) => entry.type === "browser" && Number.isInteger(entry.id) && entry.id > 0)
    .map((entry) => entry.id)
  if (rootPids.length === 0) throw new Error("Could not resolve the real browser process for diagnostics")

  const directory = await mkdtemp(path.join(tmpdir(), "claxedo-flow-profiler-"))
  const output = path.join(directory, "evidence.json")
  const desktopRoot = path.resolve(appRoot, "../claxedo-desktop")
  const profilerProcess = Bun.spawn({
    cmd: [process.execPath, path.join(desktopRoot, "scripts/performance-diagnostics-smoke.ts"), "--flow-profiler"],
    cwd: desktopRoot,
    env: {
      PATH: Bun.env.PATH ?? "",
      CLAXEDO_DIAGNOSTICS_FLOW_ROOT_PIDS: rootPids.join(","),
      CLAXEDO_DIAGNOSTICS_FLOW_OUTPUT: output,
      CLAXEDO_DIAGNOSTICS_FLOW_SOURCE: "cdp",
      CLAXEDO_DIAGNOSTICS_FLOW_INTERACTIVE: scenario === "launch-project" ? "0" : "1",
      CLAXEDO_DIAGNOSTICS_WORKER_PATH: path.join(desktopRoot, "out/main/process-metrics-worker.js"),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  void drain(profilerProcess.stderr)
  let sampling = false
  let pendingSample: Promise<void> | undefined
  const sample = () => {
    if (sampling) return
    sampling = true
    pendingSample = readBrowserProcessInfo(session)
      .then((value) => {
        profilerProcess.stdin.write(`${JSON.stringify({
          at: Date.now(),
          processes: value.processInfo,
        })}\n`)
      })
      .catch(() => undefined)
      .finally(() => {
        sampling = false
      })
  }
  sample()
  const sampleTimer = setInterval(sample, scenario === "launch-project" ? 500 : 2_000)
  try {
    await waitForProfilerReady(profilerProcess)
  } catch (error) {
    clearInterval(sampleTimer)
    await pendingSample
    profilerProcess.stdin.end()
    profilerProcess.kill()
    await Promise.race([profilerProcess.exited, Bun.sleep(2_000)])
    await detachBrowserSession(session)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  void drain(profilerProcess.stdout)
  let stopped = false
  return {
    async stop() {
      if (stopped) throw new Error("Diagnostics flow profiler was already stopped")
      stopped = true
      clearInterval(sampleTimer)
      await pendingSample
      profilerProcess.stdin.end()
      const exitCode = await Promise.race([
        profilerProcess.exited,
        Bun.sleep(20_000).then(() => undefined),
      ])
      if (exitCode === undefined) {
        profilerProcess.kill()
        await Promise.race([profilerProcess.exited, Bun.sleep(2_000)])
        throw new Error("Diagnostics flow profiler did not stop cleanly")
      }
      try {
        if (exitCode !== 0) throw new Error(`Diagnostics flow profiler exited with ${String(exitCode)}`)
        const evidence = await Bun.file(output).json() as Record<string, unknown>
        const fields = [
          "retainedBytes",
          "retainedProcesses",
          "droppedTicks",
          "maxSourceDurationMs",
          "maxReconciliationDurationMs",
          "collections",
          "sampleCount",
        ] as const
        if (fields.some((field) => typeof evidence[field] !== "number" || !Number.isFinite(evidence[field]))) {
          throw new Error("Diagnostics flow profiler evidence was incomplete")
        }
        return Object.fromEntries(fields.map((field) => [field, evidence[field]])) as Omit<
          DiagnosticsOverheadEvidence,
          "controlHeadline" | "enabledHeadline"
        >
      } finally {
        await detachBrowserSession(session)
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}

async function readBrowserProcessInfo(session: Awaited<ReturnType<Browser["newBrowserCDPSession"]>>) {
  return await Promise.race([
    session.send("SystemInfo.getProcessInfo"),
    Bun.sleep(2_000).then(() => {
      throw new Error("Timed out reading browser process metrics")
    }),
  ]) as {
    processInfo: Array<{ id: number; type: string; cpuTime: number }>
  }
}

async function detachBrowserSession(session: Awaited<ReturnType<Browser["newBrowserCDPSession"]>>) {
  await Promise.race([
    session.detach().catch(() => undefined),
    Bun.sleep(2_000),
  ])
}

async function waitForProfilerReady(profilerProcess: Bun.Subprocess<"pipe", "pipe", "pipe">) {
  const reader = profilerProcess.stdout.getReader()
  let output = ""
  try {
    const deadline = Date.now() + 15_000
    while (!output.includes("\n") && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(1, deadline - Date.now())).then(() => undefined),
      ])
      if (!chunk || chunk.done) break
      output += new TextDecoder().decode(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (!output.includes("READY")) {
    throw new Error(`Diagnostics flow profiler did not become ready: ${output.trim() || "<no output>"}`)
  }
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

// Exported for single-scenario smoke probes: one un-gated, un-paired
// execution of one flow against a running app target.
export async function executeBrowserScenario(
  browser: Browser,
  app: BrowserTarget,
  scenario: ScenarioId,
  iteration: number,
  profile: EnvironmentProfile,
): Promise<BrowserRun> {
  const seed = seedForScenario(scenario)
  const fixture = fixtureFor(scenario, seed)
  // Video is always on — one .webm per flow run.
  const context = await browser.newContext({
    viewport: benchmarkViewport,
    permissions: ["clipboard-read", "clipboard-write"],
    ...(process.env.CLAXEDO_PERF_RECORD_VIDEO === "1"
      ? { recordVideo: { dir: path.join(reportsRoot, "videos", "raw"), size: benchmarkViewport } }
      : {}),
  })
  // A throttled profile makes every wait legitimately longer; without this a
  // fixed readiness timeout fails because emulation worked, which surfaces as
  // "browser scenario crashed" rather than as a slow number.
  if (profile.timeoutScale > 1) {
    context.setDefaultTimeout(5_000 * profile.timeoutScale)
    context.setDefaultNavigationTimeout(30_000 * profile.timeoutScale)
  }
  const page = await context.newPage()
  // Before any app script: an init script is the only place all four vital
  // types can be observed from zero (see installWebVitals).
  await installWebVitals(page)
  // CPU and network emulation belong to the page, not the flow — applied here
  // so navigation itself, and therefore the load vitals, are throttled too.
  const profileCdp = await context.newCDPSession(page)
  await applyCpuProfile(profileCdp, profile)
  await applyNetworkProfile(profileCdp, profile)
  const monitor = monitorPage(page)
  const started = performance.now()
  await installMockApi(page, app, fixture, monitor, profile)
  await installSeedState(page, app, fixture)

  try {
    const flow = await runFlow(scenario, page, app, fixture)
    // After the flow, so INP reflects the interactions the flow actually drove.
    const vitals = await readWebVitals(page)
    const validation_failures = await validationFailures(page, monitor, scenario, fixture)
    if (process.env.PERF_DEBUG_ERRORS) {
      const body = await page.locator("body").innerText({ timeout: 500 }).catch(() => "")
      // The ErrorBoundary renders the error text into a readonly textarea
      // ([data-slot="input-input"]); textarea content lives in .value, which
      // body.innerText excludes, so read it explicitly.
      const boundaryError = await readBoundaryError(page)
      const state = await page.evaluate(() => {
        const raw = localStorage.getItem("claxedo.state.v5")
        const parsed = raw ? JSON.parse(raw) as {
          workbench?: { contentIds?: unknown }
          meta?: Record<string, unknown>
          terminal?: { owner?: Record<string, unknown> }
        } : undefined
        return {
          contentIds: parsed?.workbench?.contentIds,
          metaIds: Object.keys(parsed?.meta ?? {}),
          terminalIds: Object.keys(parsed?.terminal?.owner ?? {}),
          terminalRows: document.querySelectorAll("[data-testid='terminal-section'] [data-testid='rail-sidebar-terminal-row']").length,
        }
      }).catch(() => undefined)
      console.error(`\n[PERF_DEBUG ${scenario}] pageErrors:`, monitor.pageErrors)
      console.error(`[PERF_DEBUG ${scenario}] consoleErrors:`, monitor.consoleErrors)
      console.error(`[PERF_DEBUG ${scenario}] boundaryError:`, boundaryError || "<none>")
      console.error(`[PERF_DEBUG ${scenario}] failedResponses:`, monitor.failedResponses.slice(-10))
      console.error(`[PERF_DEBUG ${scenario}] failedRequests:`, monitor.failedRequests.slice(-10))
      console.error(`[PERF_DEBUG ${scenario}] unmatchedMockPaths:`, monitor.unmatchedMockPaths.slice(-20))
      console.error(`[PERF_DEBUG ${scenario}] state:`, state)
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
      vitals,
      environment: { profile: profile.id, label: profile.label },
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
  const [url, title, body, boundaryError, perfState] = await Promise.all([
    page.url(),
    page.title().catch(() => ""),
    page.locator("body").innerText({ timeout: 500 }).catch(() => ""),
    readBoundaryError(page),
    page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem("claxedo.state.v5") ?? "{}") as {
        workspacePanel?: unknown
        workbench?: { focusedPaneId?: unknown; panes?: unknown }
      }
      return {
        workspacePanel: state.workspacePanel,
        focusedPaneId: state.workbench?.focusedPaneId,
        panes: state.workbench?.panes,
        shell: document.querySelector("[data-testid='workspace-panel-shell']")?.getAttribute("data-open"),
        pending: !!document.querySelector("[data-testid='workspace-review-pending']"),
        review: document.querySelectorAll("[data-review-diff-style]").length,
        renderedHunks: Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
          .map((node) => node.dataset.reviewRenderedHunks),
        reviewRoot: document.querySelectorAll("[data-testid='review-pane-root']").length,
        lines: document.querySelectorAll("#review-panel [data-line]").length,
      }
    }).catch(() => undefined),
  ])
  const details = [
    base,
    `url=${url}`,
    title ? `title=${title}` : undefined,
    body.trim() ? `body=${body.replace(/\s+/g, " ").trim().slice(0, 240)}` : "body=<empty>",
    boundaryError ? `boundaryError=${boundaryError.replace(/\s+/g, " ").trim().slice(0, 600)}` : undefined,
    perfState ? `perfState=${JSON.stringify(perfState)}` : undefined,
    monitor.pageErrors.length ? `pageErrors=${monitor.pageErrors.slice(-3).join(" | ")}` : undefined,
    monitor.consoleErrors.length ? `consoleErrors=${monitor.consoleErrors.slice(-3).join(" | ")}` : undefined,
    monitor.failedResponses.length ? `failedResponses=${monitor.failedResponses.slice(-5).join(" | ")}` : undefined,
    monitor.failedRequests.length ? `failedRequests=${monitor.failedRequests.slice(-5).join(" | ")}` : undefined,
    monitor.unmatchedMockPaths.length ? `unmatchedMockPaths=${monitor.unmatchedMockPaths.slice(-8).join(" | ")}` : undefined,
  ].filter((item): item is string => !!item)
  return details.join("; ")
}

// The app's single ErrorBoundary (src/app/entry/app.tsx -> routes/error.tsx)
// renders the caught error into a Kobalte textarea [data-slot="input-input"].
// Textarea content lives in .value, not innerText, so every body.innerText
// diagnostic misses it — this read is the eyes for boundary failures.
async function readBoundaryError(page: Page) {
  return await page
    .locator('[data-slot="input-input"]')
    .first()
    .inputValue({ timeout: 500 })
    .catch(() => "")
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
    // Not inherited from rawRuns[0] via the spread: that would report the first
    // iteration's vitals as if they described the whole merge.
    vitals: mergeWebVitals(rawRuns.map((result) => result.vitals).filter((item): item is WebVitals => !!item)),
    validation_failures: rawRuns.flatMap((result) => result.validation_failures ?? []),
    artifacts: rawRuns.at(-1)?.artifacts,
  }
}

export function mergeDiagnosticsRuns(
  runs: Array<Omit<DiagnosticsOverheadEvidence, "controlHeadline" | "enabledHeadline">>,
) {
  if (runs.length === 0) throw new Error("Cannot merge diagnostics evidence without profiler runs")
  return {
    retainedBytes: Math.max(...runs.map((run) => run.retainedBytes)),
    retainedProcesses: Math.max(...runs.map((run) => run.retainedProcesses)),
    droppedTicks: runs.reduce((sum, run) => sum + run.droppedTicks, 0),
    maxSourceDurationMs: Math.max(...runs.map((run) => run.maxSourceDurationMs)),
    maxReconciliationDurationMs: Math.max(...runs.map((run) => run.maxReconciliationDurationMs)),
    collections: runs.reduce((sum, run) => sum + run.collections, 0),
    sampleCount: runs.reduce((sum, run) => sum + run.sampleCount, 0),
  }
}

// The flow registry. Each driver returns one headline FrameMetric + debug
// sub-metrics. To add a flow: add it to ScenarioId/FLOWS/seed, then add a driver.
const flowDrivers: Record<ScenarioId, (page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>) => Promise<FlowResult>> = {
  "launch-project": launchProject,
  "session-switch": sessionSwitch,
  "live-terminal-switch": liveTerminalSwitch,
  "large-diff-toggle": largeDiffToggle,
  "heavy-workspace-reopen": heavyWorkspaceReopen,
  "heavy-workspace-review-resume": heavyWorkspaceReopen,
  "heavy-workspace-close": heavyWorkspaceReopen,
  "workspace-switch": workspaceSwitch,
  "workspace-lifecycle": workspaceLifecycle,
  "workspace-interactions": workspaceInteractions,
  "session-switch-workspace": sessionSwitchWorkspace,
}

async function runFlow(scenario: ScenarioId, page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>) {
  return flowDrivers[scenario](page, app, fixture)
}

async function launchProject(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  await installPageLoadRecorder(page)
  const started = performance.now()
  const session = fixture.sessions[0]!
  const launch = await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)
  await waitForSessionComposer(page)
  const transcriptReady = performance.now() - started
  await showSessionInventory(page, fixture, fixture.sessions.length, { settle: "frame" })
  const headline = await stopPageLoadRecorder(page, "launch-project", performance.now() - started)
  return {
    headline,
    debug: [
      lower("launch_first_window_ms", launch.domContentLoaded),
      lower("launch_workspace_ready_ms", launch.ready),
      lower("transcript_render_ms", transcriptReady),
    ],
  }
}

async function sessionSwitch(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const first = fixture.sessions[0]!
  const second = fixture.sessions[1] ?? first
  const renderer = fixture.sessionRenderer
  const renderMermaid = process.env.CLAXEDO_PERF_MERMAID_EXPLICIT !== "0"
  await launchTo(page, app, sessionPath(first, first.id))
  await waitForTranscript(page, fixture, first.id, first.title)
  await showSessionInventory(page, fixture, Math.min(2, fixture.sessions.length))
  const prefetchSettleMs = Number(process.env.CLAXEDO_PERF_SESSION_PREFETCH_SETTLE_MS ?? "0")
  if (prefetchSettleMs > 0) await page.waitForTimeout(prefetchSettleMs)
  if (process.env.CLAXEDO_PERF_WARM_SESSION_SWITCH === "1") {
    await measureInPageSessionFirstFoldSwitch(page, second, { renderer, renderMermaid })
    await waitForTranscript(page, fixture, second.id, second.title)
    await measureInPageSessionFirstFoldSwitch(page, first, { renderer, renderMermaid })
    await waitForTranscript(page, fixture, first.id, first.title)
  }

  let singleSwitchMs = 0
  const perSwitchMetrics: Measurement[] = []
  const perSwitchCdp = process.env.CLAXEDO_PERF_PER_SWITCH === "1"
    ? await page.context().newCDPSession(page)
    : undefined
  await perSwitchCdp?.send("Performance.enable")

  const measuredSwitch = async (
    index: number,
    target: typeof first,
  ) => {
    const state = perSwitchCdp
      ? await page.locator(
          `[data-testid="session-page-root"][data-session-id="${target.id}"]`,
        ).count().then((count) => count > 0 ? "warm" : "cold")
      : undefined
    let before: Awaited<ReturnType<typeof readPerSwitchSnapshot>> | undefined
    let after: Awaited<ReturnType<typeof readPerSwitchSnapshot>> | undefined
    const elapsed = await measureInPageSessionFirstFoldSwitch(page, target, {
      renderer,
      renderMermaid,
      ...(perSwitchCdp
        ? {
            beforeClick: async () => {
              before = await readPerSwitchSnapshot(page, perSwitchCdp)
            },
            afterReady: async () => {
              after = await readPerSwitchSnapshot(page, perSwitchCdp)
            },
          }
        : {}),
    })
    if (before && after && state) {
      const performance = performanceMetricDelta(before.performance, after.performance)
      const prefix = `switch_${String(index).padStart(2, "0")}_${state}`
      const dom = before.dom && after.dom
        ? [
            lower(`${prefix}_attribute_mutations`, after.dom.attributesChanged - before.dom.attributesChanged, "count"),
            lower(`${prefix}_nodes_added`, after.dom.nodesAdded - before.dom.nodesAdded, "count"),
            lower(`${prefix}_nodes_removed`, after.dom.nodesRemoved - before.dom.nodesRemoved, "count"),
          ]
        : []
      perSwitchMetrics.push(
        lower(`${prefix}_completion_ms`, elapsed),
        lower(`${prefix}_script_ms`, performance.scriptMs),
        lower(`${prefix}_style_ms`, performance.recalcStyleMs),
        lower(`${prefix}_layout_ms`, performance.layoutMs),
        lower(`${prefix}_task_ms`, performance.taskMs),
        ...dom,
      )
    }
    return elapsed
  }
  // Headline: rapid back-and-forth switching between two sessions whose backing
  // histories contain 10k messages. Transcript readiness requires the loaded
  // first fold; the UI intentionally does not mount all 10k rows.
  // The frame recorder spans the whole stress loop; monitorPage simultaneously
  // catches any call-stack overflow / error-boundary as a validation failure.
  const headline = await measureInteraction(page, "session-switch", async () => {
    const rounds = Math.max(1, Number(process.env.CLAXEDO_PERF_SESSION_SWITCH_ROUNDS ?? "3"))
    for (let round = 0; round < rounds; round++) {
      const elapsed = await measuredSwitch(round * 2 + 1, second)
      if (round === 0) singleSwitchMs = elapsed
      await measuredSwitch(round * 2 + 2, first)
    }
  }).finally(() => perSwitchCdp?.detach())
  await waitForTranscript(page, fixture, first.id, first.title)
  await settleForVideo(page)
  return {
    headline,
    debug: [lower("single_switch_ms", Math.round(singleSwitchMs * 100) / 100), ...perSwitchMetrics],
  }
}

async function readPerSwitchSnapshot(page: Page, cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>>) {
  const [performance, dom] = await Promise.all([
    readPerformanceMetrics(cdp),
    readDomMutationSnapshot(page),
  ])
  return { performance, dom }
}

async function liveTerminalSwitch(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const session = fixture.sessions[0]!
  await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)
  await navigateToTerminalRoute(page, app, fixture, fixture.terminals[0]!, true)
  await navigateToTerminalRoute(page, app, fixture, fixture.terminals[1]!, false)
  await openTerminalSurface(page, fixture, fixture.terminals[0])
  await openTerminalSurface(page, fixture, fixture.terminals[1])
  let switchMs = 0
  // Headline: switching among already-open terminal surfaces. The fixture
  // proves websocket attachment with one seeded line; continuous output stress
  // belongs in a separate flow.
  const headline = await measureInteraction(page, "live-terminal-switch", async () => {
    switchMs = await measureInPageTerminalSwitch(page, fixture.terminals[0]!.id)
    await measureInPageTerminalSwitch(page, fixture.terminals[1]!.id)
    await measureInPageTerminalSwitch(page, fixture.terminals[0]!.id)
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

async function measureInPageTerminalSwitch(page: Page, terminalId: string): Promise<number> {
  return await page.evaluate(async (id) => {
    const sidebar = document.querySelector("[data-testid='terminal-section']")
    if (!sidebar) return 5000
    const target = sidebar.querySelector<HTMLElement>(
      `[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${CSS.escape(id)}"]`,
    )
    if (!target) return 5000
    const start = performance.now()
    // Same NavigationRow shape as the session rows: the activate handler is
    // on the absolute child button, not the row container.
    ;(target.querySelector<HTMLElement>('[data-slot="navigation-row-activate"]') ?? target).click()

    return await new Promise<number>((resolve) => {
      const limit = 5000
      let stableReadyFrames = 0
      const tick = () => {
        const elapsed = performance.now() - start
        const current = document.querySelector<HTMLElement>(
          `[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${CSS.escape(id)}"]`,
        )
        const pane = document.querySelector<HTMLElement>(
          `[data-testid="terminal-pane"][data-terminal-id="${CSS.escape(id)}"]`,
        )
        const ready = current?.dataset.active === "true" && !!pane && !pane.closest("[aria-hidden='true']")
        stableReadyFrames = ready ? stableReadyFrames + 1 : 0
        if (stableReadyFrames >= 2) return resolve(elapsed)
        if (elapsed > limit) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, terminalId)
}

async function largeDiffToggle(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  await launchTo(page, app, sessionPath(fixture.sessions[0]!, fixture.sessions[0]!.id))
  await waitForTranscript(page, fixture, fixture.sessions[0]!.id, fixture.sessions[0]!.title)
  const reviewPanelOpenMs = await measureWorkspacePanelOpen(page, fixture)
  const vcsLoadMs = await measureReviewChangedFileReady(page, fixture)
  await waitForReviewChangedFiles(page, fixture, { timeout: 2_000 })
  const firstHunkReadyMs = await openFirstReviewDiff(page)
  await waitForReviewStable(page)
  // Headline: toggling split/unified with a 500-file model. The review mounts
  // its first progressive header batch and the opened diff body before timing.
  // Readiness waits are semantic and do not scan every diff line or force layout.
  const headline = await measureInteraction(page, "large-diff-toggle", async () => {
    await toggleDiffStyle(page, { settle: "frame" })
    await toggleDiffStyle(page, { settle: "frame" })
  })
  return {
    headline,
    debug: [
      lower("review_panel_open_ms", reviewPanelOpenMs),
      lower("vcs_load_ms", vcsLoadMs),
      lower("first_hunk_ready_ms", firstHunkReadyMs),
    ],
  }
}

async function openFirstReviewDiff(page: Page) {
  const item = page.locator("#review-panel [data-review-file]").first()
  await item.waitFor({ state: "visible", timeout: 2_000 })
  const trigger = item.locator('[data-testid$="-trigger"]').first()
  const renderedBefore = await page.evaluate(() => Number(
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
      .find((node) => !node.closest("[aria-hidden='true']"))
      ?.dataset.reviewRenderedHunks ?? "0",
  ))
  const started = performance.now()
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click({ timeout: 2_000 })
  await page.waitForFunction((before) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
      .some((node) => !node.closest("[aria-hidden='true']") && Number(node.dataset.reviewRenderedHunks ?? "0") > before),
  renderedBefore, { timeout: 2_000 })
  await waitForAnimationFrame(page, 2)
  return Math.round((performance.now() - started) * 100) / 100
}

type HeavyWorkspaceReopenObservation = {
  completionMs: number
  timedOut: boolean
  blankFrames: number
  loadingFrames: number
  stableReadyFrames: number
  identity: HeavyWorkspaceSurfaceIdentity
}

type HeavyWorkspaceReviewResumeObservation = {
  completionMs: number
  timedOut: boolean
  blankFrames: number
  loadingFrames: number
  stableReadyFrames: number
  identity: HeavyWorkspaceReviewIdentity
  scrollDiagnostic?: {
    action: string
    attempt: number
    canRecord: boolean
    currentTop?: number
    position: { top: number; anchorPath?: string; anchorOffset?: number }
    restoring: boolean
    visible: boolean
  }
}

async function readHeavyWorkspaceScrollDiagnostic(page: Page) {
  return await page.evaluate((scrollSelector) => {
    // Under disposal the Review body (and its scroll element) is unmounted
    // while another workspace tab is active; the workspace root carries the
    // same diagnostic for exactly that state. Prefer the live scroll element.
    const scroll = document.querySelector<HTMLElement>(
      `[data-testid='workspace-panel-shell'] [data-testid='review-pane-root'] ${scrollSelector}`,
    ) ?? document.querySelector<HTMLElement>(
      "[data-testid='workspace-panel-shell'] [data-testid='review-pane-root']",
    )
    const diagnostic = scroll && (scroll as unknown as Record<string, unknown>).__claxedoReviewScrollDiagnostic
    return typeof diagnostic === "function" ? diagnostic() : undefined
  }, HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR)
}

async function heavyWorkspaceReopen(
  page: Page,
  app: BrowserTarget,
  fixture: ReturnType<typeof fixtureFor>,
): Promise<FlowResult> {
  const session = fixture.sessions[0]!
  await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)

  // Build the state entirely through visible product controls: open Review,
  // expand a real diff, switch to Files, and open three repository files. The
  // fixture exposes 500 VCS rows and three persisted terminal identities, but
  // injects no app events to create the state under test.
  await openReviewSurface(page, fixture, { settle: "frame" })
  await waitForReviewChangedFiles(page, fixture, { timeout: 2_000 })
  await openFirstReviewDiff(page)
  await waitForReviewStable(page)
  await waitForHeavyReviewCorpus(page, fixture)
  // The expanded diff lives at the top of the list. With the windowed file
  // list it leaves the DOM once the deep scroll moves the window away, so its
  // evidence must be read here, not from the post-scroll identity.
  const reviewAtTop = await readHeavyWorkspaceReviewIdentity(page)
  if (reviewAtTop.expandedPaths.length === 0) {
    recordVisualFailure(fixture, "heavy workspace setup had no expanded review diff")
  }
  if (reviewAtTop.expandedBodyPaths.length !== reviewAtTop.expandedPaths.length || reviewAtTop.renderedHunks === 0) {
    recordVisualFailure(fixture, "heavy workspace setup had no fully rendered expanded review body")
  }
  const deepReviewPath = fixture.changedFiles[Math.floor(fixture.changedFiles.length * 0.7)]?.file ?? ""
  await scrollHeavyReviewWorkingSet(page, fixture)
  const scrollAfterDeepPosition = await readHeavyWorkspaceScrollDiagnostic(page)
  const reviewBefore = await readHeavyWorkspaceReviewIdentity(page)
  for (const failure of heavyWorkspaceWindowedCorpusFailures({
    reviewFileCount: reviewBefore.reviewFileCount,
    totalFileCount: reviewBefore.totalFileCount,
    expectedTotal: fixture.changedFiles.length,
  })) recordVisualFailure(fixture, `heavy workspace setup: ${failure}`)
  if (!reviewBefore.scrollAnchorPath || reviewBefore.scrollTop <= 0) {
    recordVisualFailure(fixture, "heavy workspace setup did not establish a deep Review scroll position")
  }
  await measureWorkspaceFiles(page, fixture, { settle: "frame" })
  const scrollAfterNavigator = await readHeavyWorkspaceScrollDiagnostic(page)
  for (const failure of heavyWorkspaceSetupScrollFailures({
    before: scrollAfterDeepPosition,
    after: scrollAfterNavigator,
    expectedAnchorPath: deepReviewPath,
    stage: "while opening Files",
  })) recordVisualFailure(fixture, failure)
  for (const filePath of HEAVY_WORKSPACE_REOPEN_FILE_PATHS) {
    await openWorkspaceFileTab(page, fixture, filePath)
  }
  const scrollAfterFileTabs = await readHeavyWorkspaceScrollDiagnostic(page)
  for (const failure of heavyWorkspaceSetupScrollFailures({
    before: scrollAfterNavigator,
    after: scrollAfterFileTabs,
    expectedAnchorPath: deepReviewPath,
    stage: "while opening file tabs",
  })) recordVisualFailure(fixture, failure)
  await waitForAnimationFrame(page, 2)

  const before = await readHeavyWorkspaceSurfaceIdentity(page)
  for (const failure of heavyWorkspaceLiveFileFailures(before)) recordVisualFailure(fixture, failure)
  if (before.openTabIds.length < HEAVY_WORKSPACE_REOPEN_FILE_PATHS.length + 1) {
    recordVisualFailure(
      fixture,
      `heavy workspace setup opened only ${before.openTabIds.length} tabs; expected Review plus ${HEAVY_WORKSPACE_REOPEN_FILE_PATHS.length} files`,
    )
  }
  const closeMetric = await measureInteraction(page, "heavy-workspace-close", () => closeHeavyWorkspacePanel(page), {
    armAt: "trusted-pointerdown",
  })
  const closeCompletionMs = closeMetric.completionMs
  if (closeCompletionMs >= 5_000) recordVisualFailure(fixture, "heavy workspace panel did not finish closing")
  await page.waitForTimeout(HEAVY_WORKSPACE_CLOSE_DWELL_MS)
  const closedOwnership = await page.evaluate(() => ({
    shells: document.querySelectorAll("[data-testid='workspace-panel-shell']").length,
    tabs: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-slot='workspace-tab']").length,
    fileRoots: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='tab-file-root']").length,
    navigators: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='workspace-files-navigator']").length,
    reviewRoots: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='review-pane-root']").length,
    reviewFiles: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-review-file]").length,
  }))
  const requireDisposal = process.env[HEAVY_WORKSPACE_REQUIRE_DISPOSAL_ENV] === "1"
  if (requireDisposal) {
    for (const failure of heavyWorkspaceClosedOwnershipFailures(closedOwnership)) {
      recordVisualFailure(fixture, failure)
    }
  }

  let reopened: HeavyWorkspaceReopenObservation | undefined
  const reopenControl = await prepareHeavyWorkspaceReopen(page)
  const headline = await measureInteraction(page, "heavy-workspace-reopen", async () => {
    reopened = await reopenHeavyWorkspacePanel(page, before, reopenControl)
    return reopened.completionMs
  }, { armAt: "trusted-pointerdown" })
  const observation = reopened
  if (!observation) throw new Error("heavy workspace reopen produced no observation")
  if (observation.timedOut) recordVisualFailure(fixture, "heavy workspace reopen did not reach two stable ready frames")
  for (const failure of heavyWorkspaceRestorationFailures(before, observation.identity)) {
    recordVisualFailure(fixture, failure)
  }

  // A file tab is active here. The workspace shell remains mounted, but only
  // the active tab may own a heavy surface.
  const inactiveReviewOwnership = await page.evaluate(() => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-testid='workspace-panel-shell'][data-open='true'] [data-testid='workspace-review-body']",
    ))
    return {
      roots: roots.length,
      fileRoots: document.querySelectorAll(
        "[data-testid='workspace-panel-shell'][data-open='true'] [data-testid='tab-file-root']",
      ).length,
    }
  })
  if (requireDisposal) {
    for (const failure of heavyWorkspaceInactiveReviewOwnershipFailures(inactiveReviewOwnership)) {
      recordVisualFailure(fixture, failure)
    }
  }

  let reviewResumed: HeavyWorkspaceReviewResumeObservation | undefined
  const reviewResumeControl = await prepareHeavyWorkspaceReviewResume(page)
  const reviewResumeMetric = await measureInteraction(page, "heavy-workspace-review-resume", async () => {
    reviewResumed = await resumeHeavyWorkspaceReview(page, reviewBefore, reviewResumeControl)
    return reviewResumed.completionMs
  }, { armAt: "trusted-pointerdown" })
  const reviewObservation = reviewResumed
  if (!reviewObservation) throw new Error("heavy workspace Review resume produced no observation")
  if (reviewObservation.timedOut) {
    recordVisualFailure(fixture, "heavy workspace Review did not restore to two stable ready frames")
    recordVisualFailure(fixture, `heavy workspace Review scroll diagnostic: ${JSON.stringify(reviewObservation.scrollDiagnostic)}`)
  }
  for (const failure of heavyWorkspaceReviewRestorationFailures(reviewBefore, reviewObservation.identity)) {
    recordVisualFailure(fixture, failure)
  }
  // The expanded diff's evidence lives in reviewAtTop, captured before the
  // deep scroll unmounted its row; reviewBefore and the resumed identity both
  // describe the deep window where no expanded row exists, so comparing them
  // can never detect a lost expansion. With every scroll-restoration assertion
  // already recorded, scroll the restored surface back to the top so the
  // expanded rows rematerialize, and require the setup expansion to survive.
  const expandedAfterResume = await readHeavyWorkspaceExpansionAtTop(page, reviewAtTop.expandedPaths)
  for (const failure of heavyWorkspaceExpansionRetentionFailures({
    expandedAtSetup: reviewAtTop.expandedPaths,
    expandedAfterResume,
  })) recordVisualFailure(fixture, failure)
  const inactiveFileOwnership = await page.evaluate(() => ({
    fileRoots: document.querySelectorAll(
      "[data-testid='workspace-panel-shell'][data-open='true'] [data-testid='tab-file-root']",
    ).length,
  }))
  if (requireDisposal) {
    for (const failure of heavyWorkspaceInactiveFileOwnershipFailures(inactiveFileOwnership)) {
      recordVisualFailure(fixture, failure)
    }
  }

  for (const [phase, metric] of [
    ["close", closeMetric],
    ["reopen", headline],
    ["Review resume", reviewResumeMetric],
  ] as const) {
    if (!metric.causal) {
      recordVisualFailure(fixture, `heavy workspace ${phase} has no causal measurement; set CLAXEDO_PERF_CAUSAL=1`)
      continue
    }
    if (metric.causal.performanceSource !== "trusted-window-trace" || !metric.causal.performance) {
      recordVisualFailure(
        fixture,
        `heavy workspace ${phase} has no exact trusted-window renderer work: ${metric.causal.performanceUnavailableReason ?? "unknown reason"}`,
      )
    }
    if (!metric.mainThreadTasksMs?.length) {
      recordVisualFailure(fixture, `heavy workspace ${phase} trace contained no renderer task samples`)
    }
  }

  const closePerformance = closeMetric.causal?.performance
  const closeDom = closeMetric.causal?.dom
  const closeResources = closeMetric.causal?.resources
  const closeLoaf = closeMetric.causal?.longAnimationFrames
  const performance = headline.causal?.performance
  const dom = headline.causal?.dom
  const resources = headline.causal?.resources
  const reviewPerformance = reviewResumeMetric.causal?.performance
  const reviewDom = reviewResumeMetric.causal?.dom
  const reviewResources = reviewResumeMetric.causal?.resources
  return {
    headline: fixture.scenario === "heavy-workspace-close"
      ? closeMetric
      : fixture.scenario === "heavy-workspace-review-resume"
        ? reviewResumeMetric
        : headline,
    debug: [
      lower("workspace_close_completion_ms", closeCompletionMs),
      ...(closePerformance ? [
        lower("workspace_close_script_ms", closePerformance.scriptMs),
        lower("workspace_close_style_ms", closePerformance.recalcStyleMs),
        lower("workspace_close_layout_ms", closePerformance.layoutMs),
        lower("workspace_close_task_ms", closePerformance.taskMs),
      ] : []),
      lower("workspace_close_p95_renderer_interval_ms", closeMetric.p95FrameMs),
      lower("workspace_close_worst_renderer_interval_ms", closeMetric.worstFrameMs),
      lower("workspace_close_renderer_intervals_over_16_67_ms", closeMetric.framesOver1667, "count"),
      lower("workspace_close_renderer_interval_samples", closeMetric.sampleCount, "count"),
      ...(closeLoaf ? [
        lower("workspace_close_loaf_count", closeLoaf.length, "count"),
        lower("workspace_close_loaf_duration_ms", closeLoaf.reduce((sum, frame) => sum + frame.duration, 0)),
        lower("workspace_close_loaf_blocking_ms", closeLoaf.reduce((sum, frame) => sum + frame.blockingDuration, 0)),
      ] : []),
      ...(closeDom ? [
        lower("workspace_close_attribute_mutations", closeDom.attributesChanged, "count"),
        lower("workspace_close_nodes_added", closeDom.nodesAdded, "count"),
        lower("workspace_close_nodes_removed", closeDom.nodesRemoved, "count"),
      ] : []),
      ...(closeResources ? [
        lower("workspace_close_resource_requests", closeResources.length, "count"),
        lower("workspace_close_resource_transfer_bytes", closeResources.reduce((sum, resource) => sum + resource.transferSize, 0), "bytes"),
      ] : []),
      lower("workspace_close_dwell_ms", HEAVY_WORKSPACE_CLOSE_DWELL_MS),
      lower("workspace_disposal_required", requireDisposal ? 1 : 0, "count"),
      lower("workspace_closed_shells_after_dwell", closedOwnership.shells, "count"),
      lower("workspace_closed_tabs_after_dwell", closedOwnership.tabs, "count"),
      lower("workspace_closed_file_roots_after_dwell", closedOwnership.fileRoots, "count"),
      lower("workspace_closed_navigators_after_dwell", closedOwnership.navigators, "count"),
      lower("workspace_closed_review_roots_after_dwell", closedOwnership.reviewRoots, "count"),
      lower("workspace_closed_review_files_after_dwell", closedOwnership.reviewFiles, "count"),
      lower("workspace_reopen_completion_ms", observation.completionMs),
      ...(performance ? [
        lower("workspace_reopen_script_ms", performance.scriptMs),
        lower("workspace_reopen_style_ms", performance.recalcStyleMs),
        lower("workspace_reopen_layout_ms", performance.layoutMs),
        lower("workspace_reopen_task_ms", performance.taskMs),
      ] : []),
      lower("workspace_reopen_p95_renderer_interval_ms", headline.p95FrameMs),
      lower("workspace_reopen_worst_renderer_interval_ms", headline.worstFrameMs),
      lower("workspace_reopen_renderer_intervals_over_16_67_ms", headline.framesOver1667, "count"),
      lower("workspace_reopen_renderer_interval_samples", headline.sampleCount, "count"),
      lower("workspace_reopen_attribute_mutations", dom?.attributesChanged ?? 0, "count"),
      lower("workspace_reopen_nodes_added", dom?.nodesAdded ?? 0, "count"),
      lower("workspace_reopen_nodes_removed", dom?.nodesRemoved ?? 0, "count"),
      lower("workspace_reopen_blank_frames", observation.blankFrames, "count"),
      lower("workspace_reopen_loading_frames", observation.loadingFrames, "count"),
      lower("workspace_reopen_stable_ready_frames", observation.stableReadyFrames, "count"),
      ...(resources ? [
        lower("workspace_reopen_resource_requests", resources.length, "count"),
        lower("workspace_reopen_resource_duration_ms", resources.reduce((sum, resource) => sum + resource.duration, 0)),
        lower("workspace_reopen_resource_transfer_bytes", resources.reduce((sum, resource) => sum + resource.transferSize, 0), "bytes"),
      ] : []),
      lower("workspace_reopen_open_tabs", observation.identity.openTabIds.length, "count"),
      lower("workspace_reopen_inactive_review_roots", inactiveReviewOwnership.roots, "count"),
      lower("workspace_reopen_file_roots", inactiveReviewOwnership.fileRoots, "count"),
      lower("workspace_review_resume_completion_ms", reviewObservation.completionMs),
      ...(reviewPerformance ? [
        lower("workspace_review_resume_script_ms", reviewPerformance.scriptMs),
        lower("workspace_review_resume_style_ms", reviewPerformance.recalcStyleMs),
        lower("workspace_review_resume_layout_ms", reviewPerformance.layoutMs),
        lower("workspace_review_resume_task_ms", reviewPerformance.taskMs),
      ] : []),
      lower("workspace_review_resume_p95_renderer_interval_ms", reviewResumeMetric.p95FrameMs),
      lower("workspace_review_resume_worst_renderer_interval_ms", reviewResumeMetric.worstFrameMs),
      lower("workspace_review_resume_renderer_intervals_over_16_67_ms", reviewResumeMetric.framesOver1667, "count"),
      lower("workspace_review_resume_renderer_interval_samples", reviewResumeMetric.sampleCount, "count"),
      lower("workspace_review_resume_attribute_mutations", reviewDom?.attributesChanged ?? 0, "count"),
      lower("workspace_review_resume_nodes_added", reviewDom?.nodesAdded ?? 0, "count"),
      lower("workspace_review_resume_nodes_removed", reviewDom?.nodesRemoved ?? 0, "count"),
      lower("workspace_review_resume_blank_frames", reviewObservation.blankFrames, "count"),
      lower("workspace_review_resume_loading_frames", reviewObservation.loadingFrames, "count"),
      lower("workspace_review_resume_stable_ready_frames", reviewObservation.stableReadyFrames, "count"),
      ...(reviewResources ? [
        lower("workspace_review_resume_resource_requests", reviewResources.length, "count"),
        lower("workspace_review_resume_resource_duration_ms", reviewResources.reduce((sum, resource) => sum + resource.duration, 0)),
        lower("workspace_review_resume_resource_transfer_bytes", reviewResources.reduce((sum, resource) => sum + resource.transferSize, 0), "bytes"),
      ] : []),
      lower("workspace_review_resume_review_files", reviewObservation.identity.reviewFileCount, "count"),
      lower("workspace_review_resume_total_files", reviewObservation.identity.totalFileCount, "count"),
      lower("workspace_review_resume_rendered_hunks", reviewObservation.identity.renderedHunks, "count"),
      lower("workspace_review_resume_expanded_diffs", reviewObservation.identity.expandedPaths.length, "count"),
      lower("workspace_review_resume_rendered_expanded_bodies", reviewObservation.identity.expandedBodyPaths.length, "count"),
      lower("workspace_review_resume_retained_expanded_diffs", expandedAfterResume.length, "count"),
      lower("workspace_review_resume_scroll_top", reviewObservation.identity.scrollTop, "px"),
      lower("workspace_review_resume_inactive_file_roots", inactiveFileOwnership.fileRoots, "count"),
    ],
  }
}

async function openWorkspaceFileTab(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  filePath: string,
) {
  const navigator = page.locator("[data-testid='workspace-files-navigator'][data-mode='files']").last()
  const search = navigator.locator("input[placeholder='Search files...']").first()
  if (!await search.waitFor({ state: "visible", timeout: 2_000 }).then(() => true).catch(() => false)) {
    recordVisualFailure(fixture, `Files navigator was unavailable while opening ${filePath}`)
    return
  }
  await search.fill(filePath)
  const row = navigator.locator(`[data-file-tree-path="${filePath}"]`).first()
  if (!await row.waitFor({ state: "visible", timeout: 3_000 }).then(() => true).catch(() => false)) {
    const diagnostic = await navigator.evaluate((root, filePath) => {
      const describe = (element: Element | null) => {
        if (!element) return undefined
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const data = (element as HTMLElement | SVGElement).dataset
        return {
          tag: element.tagName.toLowerCase(),
          testId: data.testid,
          slot: data.slot,
          state: data.state,
          ariaHidden: element.getAttribute("aria-hidden"),
          hidden: element instanceof HTMLElement && element.hidden,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          visibility: style.visibility,
          contentVisibility: style.contentVisibility,
          opacity: style.opacity,
          overflow: style.overflow,
        }
      }
      const exact = root.querySelector<HTMLElement>(`[data-file-tree-path="${CSS.escape(filePath)}"]`)
      const ancestors: ReturnType<typeof describe>[] = []
      for (let current = exact?.parentElement; current && current !== root; current = current.parentElement) {
        const detail = describe(current)
        if (detail?.hidden || detail?.ariaHidden === "true" || detail?.display === "none" || detail?.rect.width === 0 || detail?.rect.height === 0) {
          ancestors.push(detail)
        }
      }
      return {
        query: root.querySelector<HTMLInputElement>("input[placeholder='Search files...']")?.value,
        navigatorCount: document.querySelectorAll("[data-testid='workspace-files-navigator'][data-mode='files']").length,
        navigator: describe(root),
        row: describe(exact),
        hiddenOrZeroAncestors: ancestors.slice(0, 8),
        rows: Array.from(root.querySelectorAll<HTMLElement>("[data-file-tree-path]"))
          .slice(0, 8)
          .map((item) => item.dataset.fileTreePath),
        loading: !!root.querySelector("[data-file-tree-loading], [class*='animate-spin']"),
        text: root.textContent?.replace(/\s+/g, " ").trim().slice(0, 240),
      }
    }, filePath).catch(() => undefined)
    recordVisualFailure(fixture, `Files navigator did not return ${filePath}; state=${JSON.stringify(diagnostic)}`)
    return
  }
  await row.click({ timeout: 2_000 })
  const ready = await page.waitForFunction(({ filePath, filename }) => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    if (!shell) return false
    const selected = Array.from(shell.querySelectorAll<HTMLElement>("[data-slot='workspace-tab'][data-selected='true']"))
      .find((tab) => tab.dataset.workspaceTabKind === "file" && tab.textContent?.includes(filename))
    const selectedPath = shell.querySelector<HTMLElement>(
      `[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path="${CSS.escape(filePath)}"][aria-selected='true']`,
    )
    const activeFile = shell.querySelector<HTMLElement>(
      `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(filePath)}"][data-tab-file-state='ready']`,
    )
    if (!selected || !selectedPath || !activeFile) return false
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const loading = Array.from(shell.querySelectorAll<HTMLElement>("div, span"))
      .some((node) => visible(node) && node.children.length === 0 && node.textContent?.trim() === "Loading...")
    return visible(activeFile) && !loading
  }, { filePath, filename: path.basename(filePath) }, { timeout: 5_000 }).then(() => true).catch(() => false)
  if (!ready) recordVisualFailure(fixture, `Workspace file tab did not become ready: ${filePath}`)
}

async function closeHeavyWorkspacePanel(page: Page) {
  const control = page.locator("button[aria-label='Close workspace panel']:visible").last()
  await control.waitFor({ state: "visible", timeout: 2_000 })
  const mark = `claxedo-heavy-workspace-close-${crypto.randomUUID()}`
  await control.evaluate((node, mark) => {
    performance.clearMarks(mark)
    node.addEventListener("pointerdown", (event) => {
      if (event.isTrusted) performance.mark(mark)
    }, { once: true })
  }, mark)
  await control.click({ timeout: 2_000 })
  return await page.evaluate(async (mark) => {
    const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
    if (started === undefined) throw new Error("Trusted workspace close did not emit pointerdown")
    const completion = await new Promise<number>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - started
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
        const closed = !shell || (
          shell.dataset.open === "false" &&
          (shell.getAttribute("aria-hidden") === "true" || getComputedStyle(shell).display === "none")
        )
        if (closed || elapsed >= 5_000) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    performance.clearMarks(mark)
    return completion
  }, mark)
}

async function reopenHeavyWorkspacePanel(
  page: Page,
  expected: HeavyWorkspaceSurfaceIdentity,
  control: { mark: string; x: number; y: number },
): Promise<HeavyWorkspaceReopenObservation> {
  await page.mouse.click(control.x, control.y)
  return await page.evaluate(async ({ expected, mark }) => {
    const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
    if (started === undefined) throw new Error("Trusted workspace reopen did not emit pointerdown")
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const identity = (): HeavyWorkspaceSurfaceIdentity => {
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
      const tabs = Array.from(shell?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']") ?? [])
      const active = tabs.find((tab) => tab.dataset.selected === "true")
      const review = tabs.find((tab) => tab.dataset.workspaceTabKind === "review")
      const selectedFile = shell?.querySelector<HTMLElement>(
        "[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path][aria-selected='true']",
      )
      const activeFile = Array.from(shell?.querySelectorAll<HTMLElement>(
        "[data-testid='tab-file-root'][data-tab-file-state='ready']",
      ) ?? []).find(visible)
      const navigator = shell?.querySelector<HTMLElement>("[data-testid='workspace-files-navigator']")
      return {
        openTabIds: tabs.map((tab) => tab.dataset.workspaceTabId ?? ""),
        activeTabId: active?.dataset.workspaceTabId,
        selectedFilePath: selectedFile?.dataset.fileTreePath,
        selectedFileChars: Number(activeFile?.dataset.tabFileContentChars ?? "0"),
        selectedFileLines: Number(activeFile?.dataset.tabFileContentLines ?? "0"),
        navigatorMode: navigator?.dataset.mode,
        reviewTabId: review?.dataset.workspaceTabId,
      }
    }
    const sameStrings = (left: readonly string[], right: readonly string[]) =>
      left.length === right.length && left.every((value, index) => value === right[index])
    const exactIdentity = (current: HeavyWorkspaceSurfaceIdentity) =>
      sameStrings(current.openTabIds, expected.openTabIds) &&
      current.activeTabId === expected.activeTabId &&
      current.selectedFilePath === expected.selectedFilePath &&
      current.selectedFileChars === expected.selectedFileChars &&
      current.selectedFileLines === expected.selectedFileLines &&
      current.navigatorMode === expected.navigatorMode &&
      current.reviewTabId === expected.reviewTabId
    let blankFrames = 0
    let loadingFrames = 0
    let stableReadyFrames = 0
    let lastSignature = ""
    let finalIdentity = identity()
    const completionMs = await new Promise<number>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - started
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
        finalIdentity = identity()
        const panelVisible = !!shell && visible(shell) && shell.getBoundingClientRect().width > 120
        const activeFile = expected.selectedFilePath && shell?.querySelector<HTMLElement>(
          `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(expected.selectedFilePath)}"][data-tab-file-state='ready']`,
        )
        const semanticBody = !!activeFile && visible(activeFile)
        if (panelVisible && !semanticBody) blankFrames++
        const loading = !!shell && Array.from(shell.querySelectorAll<HTMLElement>("div, span"))
          .some((node) => visible(node) && node.children.length === 0 && node.textContent?.trim() === "Loading...")
        if (panelVisible && loading) loadingFrames++
        const ready = panelVisible && semanticBody && !loading && exactIdentity(finalIdentity)
        const signature = JSON.stringify(finalIdentity)
        stableReadyFrames = ready && signature === lastSignature ? stableReadyFrames + 1 : ready ? 1 : 0
        lastSignature = signature
        if (stableReadyFrames >= 2 || elapsed >= 5_000) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    performance.clearMarks(mark)
    return {
      completionMs,
      timedOut: completionMs >= 5_000,
      blankFrames,
      loadingFrames,
      stableReadyFrames,
      identity: finalIdentity,
    }
  }, { expected, mark: control.mark })
}

async function prepareHeavyWorkspaceReviewResume(page: Page) {
  const control = page.locator(
    "[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='review'] button",
  ).first()
  await control.waitFor({ state: "visible", timeout: 2_000 })
  const mark = `claxedo-heavy-workspace-review-resume-${crypto.randomUUID()}`
  await control.evaluate((node, mark) => {
    performance.clearMarks(mark)
    node.addEventListener("pointerdown", (event) => {
      if (event.isTrusted) performance.mark(mark)
    }, { once: true })
  }, mark)
  const box = await control.boundingBox()
  if (!box) throw new Error("Visible Review workspace tab had no clickable bounds")
  return { mark, x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function resumeHeavyWorkspaceReview(
  page: Page,
  expected: HeavyWorkspaceReviewIdentity,
  control: { mark: string; x: number; y: number },
): Promise<HeavyWorkspaceReviewResumeObservation> {
  await page.mouse.click(control.x, control.y)
  return await page.evaluate(async ({ expected, mark, scrollSelector }) => {
    const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
    if (started === undefined) throw new Error("Trusted Review workspace-tab click did not emit pointerdown")
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const identity = (): HeavyWorkspaceReviewIdentity => {
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      const root = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']") ?? [])
        .find(visible)
      const diff = root?.querySelector<HTMLElement>("[data-review-diff-style]")
      const scroll = root?.querySelector<HTMLElement>(scrollSelector)
      const semanticBody = !!scroll && visible(scroll)
      const files = semanticBody
        ? Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? []).filter(visible)
        : []
      const corpus = semanticBody
        ? root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
        : undefined
      const scrollTop = scroll?.getBoundingClientRect().top
      const scrollAnchor = scrollTop === undefined
        ? undefined
        : files.toSorted((left, right) =>
            Math.abs(left.getBoundingClientRect().top - scrollTop) - Math.abs(right.getBoundingClientRect().top - scrollTop)
          )[0]
      const expanded = files.filter((item) => !!item.querySelector("[aria-expanded='true']"))
      return {
        diffStyle: diff?.dataset.reviewDiffStyle,
        expandedPaths: expanded.map((item) => item.dataset.reviewFile ?? ""),
        expandedBodyPaths: expanded
          .filter((item) => {
            const wrapper = item.querySelector<HTMLElement>("[data-slot='session-review-diff-wrapper']")
            return !!wrapper && wrapper.childElementCount > 0 && !wrapper.querySelector("[data-slot='session-review-diff-placeholder']")
          })
          .map((item) => item.dataset.reviewFile ?? ""),
        reviewFileCount: files.length,
        totalFileCount: Number(corpus?.dataset.reviewTotalFiles ?? "0"),
        renderedHunks: Number(diff?.dataset.reviewRenderedHunks ?? "0"),
        scrollTop: scroll?.scrollTop ?? 0,
        scrollAnchorPath: scrollAnchor?.dataset.reviewFile,
        scrollAnchorOffset: scrollAnchor && scrollTop !== undefined
          ? scrollAnchor.getBoundingClientRect().top - scrollTop
          : undefined,
      }
    }
    const sameStrings = (left: readonly string[], right: readonly string[]) =>
      left.length === right.length && left.every((value, index) => value === right[index])
    let blankFrames = 0
    let loadingFrames = 0
    let stableReadyFrames = 0
    let lastSignature = ""
    let finalIdentity = identity()
    let scrollDiagnostic: HeavyWorkspaceReviewResumeObservation["scrollDiagnostic"]
    const completionMs = await new Promise<number>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - started
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
        const activeReview = shell?.querySelector<HTMLElement>(
          "[data-slot='workspace-tab'][data-workspace-tab-kind='review'][data-selected='true']",
        )
        const root = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']") ?? [])
          .find(visible)
        const scroll = root?.querySelector<HTMLElement>(scrollSelector)
        const semanticBody = !!scroll && visible(scroll)
        finalIdentity = identity()
        const diagnostic = scroll && (scroll as unknown as Record<string, unknown>).__claxedoReviewScrollDiagnostic
        scrollDiagnostic = typeof diagnostic === "function"
          ? (diagnostic as () => HeavyWorkspaceReviewResumeObservation["scrollDiagnostic"])()
          : undefined
        const panelVisible = !!shell && visible(shell) && shell.getBoundingClientRect().width > 120
        if (panelVisible && activeReview && !semanticBody) blankFrames++
        const loading = semanticBody && !!root?.querySelector(
          "[data-testid='review-pane-loading'], [data-testid='workspace-review-pending'], [data-slot='session-review-diff-placeholder']",
        )
        if (panelVisible && activeReview && loading) loadingFrames++
        const ready = panelVisible && !!activeReview && semanticBody && !loading &&
          finalIdentity.diffStyle === expected.diffStyle &&
          sameStrings(finalIdentity.expandedPaths, expected.expandedPaths) &&
          sameStrings(finalIdentity.expandedBodyPaths, expected.expandedBodyPaths) &&
          finalIdentity.reviewFileCount === expected.reviewFileCount &&
          finalIdentity.totalFileCount === expected.totalFileCount &&
          // A windowed review scrolled away from its expanded rows renders no
          // hunks on a fresh mount; the counters only compare when an expanded
          // body is expected inside the restored window.
          (expected.expandedBodyPaths.length === 0 || finalIdentity.renderedHunks >= expected.renderedHunks) &&
          finalIdentity.scrollAnchorPath === expected.scrollAnchorPath &&
          finalIdentity.scrollAnchorOffset !== undefined && expected.scrollAnchorOffset !== undefined &&
          Math.abs(finalIdentity.scrollAnchorOffset - expected.scrollAnchorOffset) <= 2 &&
          finalIdentity.scrollTop > 0
        const signature = JSON.stringify(finalIdentity)
        stableReadyFrames = ready && signature === lastSignature ? stableReadyFrames + 1 : ready ? 1 : 0
        lastSignature = signature
        if (stableReadyFrames >= 2 || elapsed >= 5_000) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    performance.clearMarks(mark)
    return {
      completionMs,
      timedOut: completionMs >= 5_000,
      blankFrames,
      loadingFrames,
      stableReadyFrames,
      identity: finalIdentity,
      scrollDiagnostic,
    }
  }, { expected, mark: control.mark, scrollSelector: HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR })
}

async function prepareHeavyWorkspaceReopen(page: Page) {
  const control = page.locator("button[aria-label='Open workspace panel']:visible").last()
  await control.waitFor({ state: "visible", timeout: 2_000 })
  const mark = `claxedo-heavy-workspace-reopen-${crypto.randomUUID()}`
  await control.evaluate((node, mark) => {
    performance.clearMarks(mark)
    node.addEventListener("pointerdown", (event) => {
      if (event.isTrusted) performance.mark(mark)
    }, { once: true })
  }, mark)
  const box = await control.boundingBox()
  if (!box) throw new Error("Visible workspace panel open control had no clickable bounds")
  return { mark, x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function readHeavyWorkspaceSurfaceIdentity(page: Page): Promise<HeavyWorkspaceSurfaceIdentity> {
  return await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const tabs = Array.from(shell?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']") ?? [])
    const active = tabs.find((tab) => tab.dataset.selected === "true")
    const review = tabs.find((tab) => tab.dataset.workspaceTabKind === "review")
    const selectedFile = shell?.querySelector<HTMLElement>(
      "[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path][aria-selected='true']",
    )
    const activeFile = Array.from(shell?.querySelectorAll<HTMLElement>(
      "[data-testid='tab-file-root'][data-tab-file-state='ready']",
    ) ?? []).find((element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    })
    const navigator = shell?.querySelector<HTMLElement>("[data-testid='workspace-files-navigator']")
    return {
      openTabIds: tabs.map((tab) => tab.dataset.workspaceTabId ?? ""),
      activeTabId: active?.dataset.workspaceTabId,
      selectedFilePath: selectedFile?.dataset.fileTreePath,
      selectedFileChars: Number(activeFile?.dataset.tabFileContentChars ?? "0"),
      selectedFileLines: Number(activeFile?.dataset.tabFileContentLines ?? "0"),
      navigatorMode: navigator?.dataset.mode,
      reviewTabId: review?.dataset.workspaceTabId,
    }
  })
}

async function readHeavyWorkspaceReviewIdentity(page: Page): Promise<HeavyWorkspaceReviewIdentity> {
  return await page.evaluate((scrollSelector) => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const root = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']") ?? [])
      .find(visible)
    const diff = root?.querySelector<HTMLElement>("[data-review-diff-style]")
    const files = Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])
    const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    const scroll = root?.querySelector<HTMLElement>(scrollSelector)
    const scrollTop = scroll?.getBoundingClientRect().top
    const scrollAnchor = scrollTop === undefined
      ? undefined
      : files.toSorted((left, right) =>
          Math.abs(left.getBoundingClientRect().top - scrollTop) - Math.abs(right.getBoundingClientRect().top - scrollTop)
        )[0]
    const expanded = files.filter((item) => !!item.querySelector("[aria-expanded='true']"))
    return {
      diffStyle: diff?.dataset.reviewDiffStyle,
      expandedPaths: expanded.map((item) => item.dataset.reviewFile ?? ""),
      expandedBodyPaths: expanded
        .filter((item) => {
          const wrapper = item.querySelector<HTMLElement>("[data-slot='session-review-diff-wrapper']")
          return !!wrapper && wrapper.childElementCount > 0 && !wrapper.querySelector("[data-slot='session-review-diff-placeholder']")
        })
        .map((item) => item.dataset.reviewFile ?? ""),
      reviewFileCount: files.length,
      totalFileCount: Number(corpus?.dataset.reviewTotalFiles ?? "0"),
      renderedHunks: Number(diff?.dataset.reviewRenderedHunks ?? "0"),
      scrollTop: scroll?.scrollTop ?? 0,
      scrollAnchorPath: scrollAnchor?.dataset.reviewFile,
      scrollAnchorOffset: scrollAnchor && scrollTop !== undefined
        ? scrollAnchor.getBoundingClientRect().top - scrollTop
        : undefined,
    }
  }, HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR)
}

// Scrolls the restored Review back to the top so rows the deep window had
// unmounted rematerialize, then reads which files are expanded. Only runs
// after every scroll-restoration assertion has been captured, so moving the
// scroll here cannot disturb the measured evidence. Waits (bounded) until the
// window has re-rendered the expected expanded rows, since the windowing memo
// reacts to the scroll event asynchronously.
async function readHeavyWorkspaceExpansionAtTop(
  page: Page,
  expectedExpandedPaths: readonly string[],
): Promise<string[]> {
  return await page.evaluate(async ({ expectedExpandedPaths, scrollSelector }) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const root = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    const scroll = root?.querySelector<HTMLElement>(scrollSelector)
    if (!root || !scroll) return []
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    scroll.scrollTop = 0
    scroll.dispatchEvent(new Event("scroll", { bubbles: true }))
    const expandedPaths = () => Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]"))
      .filter((item) => !!item.querySelector("[aria-expanded='true']"))
      .map((item) => item.dataset.reviewFile ?? "")
    for (let attempt = 0; attempt < 60; attempt++) {
      await frame()
      const expanded = expandedPaths()
      if (expectedExpandedPaths.every((path) => expanded.includes(path))) return expanded
    }
    return expandedPaths()
  }, { expectedExpandedPaths, scrollSelector: HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR })
}

async function workspaceSwitch(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  await launchTo(page, app, sessionPath(fixture.sessions[0]!, fixture.sessions[0]!.id))
  await waitForTranscript(page, fixture, fixture.sessions[0]!.id, fixture.sessions[0]!.title)
  const target = fixture.sessions.find((session) => session.directory !== fixture.sessions[0]!.directory) ?? fixture.sessions[1]!
  await showSessionInventory(page, fixture, Math.min(5, fixture.sessions.length), { settle: "frame" })
  // Headline: selecting a session whose route is owned by another workspace.
  const headline = await measureInteraction(page, "workspace-switch", async () => {
    const elapsed = await measureInPageSessionFirstFoldSwitch(page, target)
    if (elapsed >= 10_000) recordVisualFailure(fixture, "workspace target session did not render its first fold")
  })
  await waitForTranscript(page, fixture, target.id, target.title)
  const files = await measureWorkspaceFiles(page, fixture, { settle: "frame" })
  await settleForVideo(page)
  return { headline, debug: files }
}

// ---------------------------------------------------------------------------
// Isolated-interaction scenario families (workspace-lifecycle,
// workspace-interactions, session-switch-workspace). Every measured
// interaction below runs on its own clock started at a trusted pointerdown
// (or the flow's triggering event), settles behind an explicit gate before
// the next interaction starts, and reports the shared per-interaction bundle
// from isolated-interaction.ts. There are deliberately NO cumulative clocks
// across interactions.

function workspacePanelToggle(page: Page) {
  return page.locator("[data-testid='workspace-panel-toggle']:visible").last()
}

// Untrusted in-page click: activates a control WITHOUT emitting a pointerdown,
// so a recorder armed at trusted-pointerdown keeps waiting for the phase's
// actual measured click. Optionally marks the click's page-clock time so an
// interruption phase can prove its trusted click landed inside the motion.
async function syntheticVisibleClick(page: Page, selector: string, mark?: string) {
  await page.evaluate(({ selector, mark }) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const target = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible).at(-1)
    if (!target) throw new Error(`No visible element for synthetic click: ${selector}`)
    if (mark) {
      performance.clearMarks(mark)
      performance.mark(mark)
    }
    target.click()
  }, { selector, mark: mark ?? undefined })
}

// A stationary, handler-free spot in the workbench header's empty left
// region. The interruption phases deliver their trusted pointerdown here and
// relay the activation to the workspace-panel toggle synchronously inside the
// same trusted dispatch, because the toggle itself slides with the workbench
// column's animated margin during the panel motion — a coordinate captured
// before the motion would miss it.
async function workspaceHeaderInertPoint(page: Page) {
  const rect = await page.locator("[data-testid='workbench-shell-header']").first().boundingBox()
  if (!rect) throw new Error("workbench shell header had no bounds for the inert interruption click")
  return { x: rect.x + 60, y: rect.y + rect.height / 2 }
}

// Installs a one-shot capture listener that activates the (possibly moving)
// workspace-panel toggle synchronously inside the NEXT trusted pointerdown's
// dispatch. Registered inside the measured action, after the recorder's own
// trusted-pointerdown arm, so the toggle handler's work lands in the window.
async function relayNextTrustedPointerdownToWorkspaceToggle(page: Page) {
  await page.evaluate((selector) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    window.addEventListener(
      "pointerdown",
      function relay(event) {
        if (!event.isTrusted) return
        window.removeEventListener("pointerdown", relay, true)
        Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible).at(-1)?.click()
      },
      { capture: true },
    )
  }, WORKSPACE_PANEL_TOGGLE_SELECTOR)
}

async function waitForWorkspacePanelFullyClosed(page: Page) {
  await page.waitForFunction(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
    return !shell || (
      shell.dataset.open === "false" &&
      (shell.getAttribute("aria-hidden") === "true" || getComputedStyle(shell).display === "none")
    )
  }, undefined, { timeout: 5_000 })
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
  }, expectedTotal, { timeout: 12_000 })
}

// The same ownership-zero selectors the heavy-workspace disposal gates use.
async function readWorkspaceClosedOwnership(page: Page) {
  return await page.evaluate(() => ({
    shells: document.querySelectorAll("[data-testid='workspace-panel-shell']").length,
    tabs: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-slot='workspace-tab']").length,
    fileRoots: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='tab-file-root']").length,
    navigators: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='workspace-files-navigator']").length,
    reviewRoots: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='review-pane-root']").length,
    reviewFiles: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-review-file]").length,
  }))
}

function workspaceOwnershipRows(prefix: string, ownership: Awaited<ReturnType<typeof readWorkspaceClosedOwnership>>): Measurement[] {
  return Object.entries(ownership).map(([name, count]) => measurement(`${prefix}_${name}`, count, "count"))
}

const WORKSPACE_PANEL_TOGGLE_SELECTOR = "[data-testid='workspace-panel-toggle']"

async function workspaceLifecycle(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const session = fixture.sessions[0]!
  await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)
  const expectedTotal = fixture.changedFiles.length
  const timeoutMs = ISOLATED_INTERACTION_TIMEOUT_MS
  const requireDisposal = process.env[HEAVY_WORKSPACE_REQUIRE_DISPOSAL_ENV] === "1"
  const debug: Measurement[] = []
  const metrics: FrameMetric[] = []
  const settleGate = async (label: string) => {
    const gate = await settleBeforeNextInteraction(page)
    debug.push(
      measurement(`${label}_settle_gate_ms`, roundMs(gate.waitedMs)),
      measurement(`${label}_settle_gate_settled`, gate.settled ? 1 : 0, "count"),
    )
  }
  const record = (prefix: string, metric: FrameMetric, observation: IsolatedInteractionObservation, extraFailures: string[] = []) => {
    metrics.push(metric)
    debug.push(...isolatedInteractionMetricRows(prefix, metric, observation))
    for (const failure of [
      ...isolatedInteractionEvidenceFailures(prefix, metric),
      ...isolatedInteractionSettleFailures(prefix, observation),
      ...extraFailures,
    ]) recordVisualFailure(fixture, failure)
  }

  // Phase 1 (+ 4 + 5): the FIRST panel open. One trusted click, three
  // triggering-event clocks: click -> shell settled (phase 1), fetchStart ->
  // data arrival (phase 4, with click -> fetchStart reported separately so a
  // late fetch is visible), data arrival -> above-fold interactive (phase 5).
  const coldOpenControl = await prepareTrustedInteraction(page, workspacePanelToggle(page), "workspace-lifecycle-cold-open")
  const coldOpen = await measureIsolatedInteraction<
    WorkspaceLifecycleColdOpenObservation & { aboveFold: { reviewFileRows: number; totalFiles: number; pending: boolean } }
  >(page, "workspace-lifecycle-cold-open", async () => {
    await page.mouse.click(coldOpenControl.x, coldOpenControl.y)
    return await page.evaluate(async ({ mark, timeoutMs, fetchPattern, expectedTotal }) => {
      const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
      if (started === undefined) throw new Error("Trusted workspace cold open did not emit pointerdown")
      performance.setResourceTimingBufferSize?.(1_000)
      const fetchRe = new RegExp(fetchPattern)
      const visible = (element: Element) => {
        if (element.closest("[aria-hidden='true']")) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      }
      let acknowledgedMs: number | undefined
      let shellSettledMs: number | undefined
      let shellStableFrames = 0
      let lastShellSignature = ""
      let aboveFoldAt: number | undefined
      let readyStableFrames = 0
      let aboveFold = { reviewFileRows: 0, totalFiles: 0, pending: false }
      let fetchEntry: PerformanceResourceTiming | undefined
      const completionMs = await new Promise<number>((resolve) => {
        const tick = () => {
          const elapsed = performance.now() - started
          if (!fetchEntry || fetchEntry.responseEnd === 0) {
            const entries = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
              .filter((entry) => fetchRe.test(entry.name))
            fetchEntry = entries.find((entry) => entry.startTime >= started - 5) ?? entries.at(-1) ?? fetchEntry
          }
          const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
          if (acknowledgedMs === undefined && shell) acknowledgedMs = elapsed
          const shellVisible = !!shell && visible(shell) && shell.getBoundingClientRect().width > 120
          if (shellVisible && shellSettledMs === undefined) {
            const rect = shell.getBoundingClientRect()
            // approx: the app has no shell/content split yet, so "shell
            // settled" is the panel element visible with stable geometry.
            const signature = `${Math.round(rect.x)}x${Math.round(rect.width)}`
            shellStableFrames = signature === lastShellSignature ? shellStableFrames + 1 : 1
            lastShellSignature = signature
            if (shellStableFrames >= 2) shellSettledMs = elapsed
          }
          const root = shell
            ? Array.from(shell.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
            : undefined
          const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
          const rows = root ? Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]")).filter(visible) : []
          const pending = !!root?.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
          aboveFold = { reviewFileRows: rows.length, totalFiles: Number(corpus?.dataset.reviewTotalFiles ?? "0"), pending }
          const ready = shellVisible && shellSettledMs !== undefined && rows.length > 0 &&
            aboveFold.totalFiles === expectedTotal && !pending
          if (ready && aboveFoldAt === undefined) aboveFoldAt = elapsed
          readyStableFrames = ready ? readyStableFrames + 1 : 0
          if (readyStableFrames >= 2 || elapsed >= timeoutMs) return resolve(elapsed)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      performance.clearMarks(mark)
      const dataArrivedAt = fetchEntry && fetchEntry.responseEnd > 0 ? fetchEntry.responseEnd : undefined
      return {
        completionMs,
        acknowledgedMs,
        timedOut: completionMs >= timeoutMs,
        shellSettledMs,
        clickToFetchStartMs: fetchEntry ? fetchEntry.startTime - started : undefined,
        fetchStartToDataMs: fetchEntry && dataArrivedAt !== undefined ? dataArrivedAt - fetchEntry.startTime : undefined,
        dataToAboveFoldMs: dataArrivedAt !== undefined && aboveFoldAt !== undefined
          ? started + aboveFoldAt - dataArrivedAt
          : undefined,
        aboveFold,
      }
    }, { mark: coldOpenControl.mark, timeoutMs, fetchPattern: WORKSPACE_LIFECYCLE_DATA_FETCH_PATTERN.source, expectedTotal })
  })
  record("workspace_lifecycle_cold_open", coldOpen.metric, coldOpen.observation, [
    ...workspaceLifecycleColdOpenFailures(coldOpen.observation),
    ...workspaceLifecycleAboveFoldFailures(coldOpen.observation.aboveFold, expectedTotal),
  ])
  const coldObserved = coldOpen.observation
  debug.push(
    // approx: shell settle without a shell/content split (see contract note).
    ...(coldObserved.shellSettledMs !== undefined
      ? [measurement("workspace_lifecycle_shell_open_settled_ms", roundMs(coldObserved.shellSettledMs))]
      : []),
    ...(coldObserved.clickToFetchStartMs !== undefined
      ? [measurement("workspace_lifecycle_click_to_fetch_start_ms", roundMs(coldObserved.clickToFetchStartMs))]
      : []),
    ...(coldObserved.fetchStartToDataMs !== undefined
      ? [measurement("workspace_lifecycle_fetch_start_to_data_ms", roundMs(coldObserved.fetchStartToDataMs))]
      : []),
    ...(coldObserved.dataToAboveFoldMs !== undefined
      ? [measurement("workspace_lifecycle_data_to_above_fold_ms", roundMs(coldObserved.dataToAboveFoldMs))]
      : []),
  )
  await settleGate("workspace_lifecycle_cold_open")

  // Phase 2: opening -> closing interruption. Start closed, begin an
  // untrusted open, click close mid-motion (the trusted, measured input), and
  // clock recovery to fully closed. Recovery is pure animation/DOM work on
  // already-loaded data, so its request count is a hard zero.
  await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR)
  await waitForWorkspacePanelFullyClosed(page)
  await page.waitForTimeout(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS)
  await settleGate("workspace_lifecycle_before_open_close_interrupt")
  const inertPoint = await workspaceHeaderInertPoint(page)
  const interruptCloseControl = await prepareTrustedWindowInteraction(page, "workspace-lifecycle-open-close-interrupt")
  const openMark = `claxedo-perf-lifecycle-open-${crypto.randomUUID()}`
  const openCloseInterrupt = await measureIsolatedInteraction<WorkspaceLifecycleInterruptionObservation>(
    page,
    "workspace-lifecycle-open-close-interrupt",
    async () => {
      await relayNextTrustedPointerdownToWorkspaceToggle(page)
      await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR, openMark)
      await page.waitForTimeout(WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS)
      await page.mouse.click(inertPoint.x, inertPoint.y)
      return await page.evaluate(async ({ mark, openMark, timeoutMs }) => {
        const openedAt = performance.getEntriesByName(openMark, "mark").at(-1)?.startTime
        const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
        if (started === undefined) throw new Error("Trusted interrupting close did not emit pointerdown")
        let acknowledgedMs: number | undefined
        let recovered = false
        const completionMs = await new Promise<number>((resolve) => {
          const tick = () => {
            const elapsed = performance.now() - started
            const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
            if (acknowledgedMs === undefined && (!shell || shell.dataset.open === "false")) acknowledgedMs = elapsed
            const closed = !shell || (
              shell.dataset.open === "false" &&
              (shell.getAttribute("aria-hidden") === "true" || getComputedStyle(shell).display === "none")
            )
            if (closed) {
              recovered = true
              return resolve(elapsed)
            }
            if (elapsed >= timeoutMs) return resolve(elapsed)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        performance.clearMarks(mark)
        performance.clearMarks(openMark)
        return {
          completionMs,
          acknowledgedMs,
          timedOut: completionMs >= timeoutMs,
          interruptOffsetMs: openedAt === undefined ? undefined : started - openedAt,
          recovered,
        }
      }, { mark: interruptCloseControl.mark, openMark, timeoutMs })
    },
  )
  record("workspace_lifecycle_open_close_interrupt", openCloseInterrupt.metric, openCloseInterrupt.observation, [
    ...workspaceLifecycleInterruptionFailures("workspace_lifecycle_open_close_interrupt", openCloseInterrupt.observation),
    // The interrupted OPEN's click still starts the panel-open corpus
    // warm-up by design; only requests beyond that budget are a leak.
    ...clickWarmupResourceRequestFailures(
      "workspace_lifecycle_open_close_interrupt",
      isolatedInteractionResourceRequests(openCloseInterrupt.metric),
      1,
    ),
  ])
  if (openCloseInterrupt.observation.interruptOffsetMs !== undefined) {
    debug.push(measurement("workspace_lifecycle_open_close_interrupt_offset_ms", roundMs(openCloseInterrupt.observation.interruptOffsetMs)))
  }
  // No orphan DOM after the interrupted open (reuses the heavy-workspace
  // ownership-zero selectors; hard only for the disposal candidate).
  await page.waitForTimeout(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS)
  const interruptOwnership = await readWorkspaceClosedOwnership(page)
  debug.push(...workspaceOwnershipRows("workspace_lifecycle_open_close_interrupt_owned", interruptOwnership))
  if (requireDisposal) {
    for (const failure of heavyWorkspaceClosedOwnershipFailures(interruptOwnership)) {
      recordVisualFailure(fixture, `workspace_lifecycle_open_close_interrupt: ${failure}`)
    }
  }
  await settleGate("workspace_lifecycle_open_close_interrupt")

  // Phase 3: closing -> reopening interruption. Start fully open, begin an
  // untrusted close, click reopen mid-motion, clock recovery to fully open
  // (shell visible AND its still-mounted content visible). Hard zero requests.
  await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR)
  await waitForWorkspaceReviewContent(page, expectedTotal)
  await settleGate("workspace_lifecycle_before_close_reopen_interrupt")
  const reopenInertPoint = await workspaceHeaderInertPoint(page)
  const interruptReopenControl = await prepareTrustedWindowInteraction(page, "workspace-lifecycle-close-reopen-interrupt")
  const closeMark = `claxedo-perf-lifecycle-close-${crypto.randomUUID()}`
  const closeReopenInterrupt = await measureIsolatedInteraction<WorkspaceLifecycleInterruptionObservation>(
    page,
    "workspace-lifecycle-close-reopen-interrupt",
    async () => {
      await relayNextTrustedPointerdownToWorkspaceToggle(page)
      await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR, closeMark)
      await page.waitForTimeout(WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS)
      await page.mouse.click(reopenInertPoint.x, reopenInertPoint.y)
      return await page.evaluate(async ({ mark, closeMark, timeoutMs }) => {
        const closedAt = performance.getEntriesByName(closeMark, "mark").at(-1)?.startTime
        const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
        if (started === undefined) throw new Error("Trusted interrupting reopen did not emit pointerdown")
        const visible = (element: Element) => {
          if (element.closest("[aria-hidden='true']")) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        }
        let acknowledgedMs: number | undefined
        let recovered = false
        let stableFrames = 0
        let lastSignature = ""
        const completionMs = await new Promise<number>((resolve) => {
          const tick = () => {
            const elapsed = performance.now() - started
            const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
            if (acknowledgedMs === undefined && shell) acknowledgedMs = elapsed
            const shellVisible = !!shell && visible(shell) && shell.getBoundingClientRect().width > 120
            const root = shell
              ? Array.from(shell.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
              : undefined
            const contentVisible = !!root && Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]")).some(visible)
            const ready = shellVisible && contentVisible
            const rect = shell?.getBoundingClientRect()
            const signature = rect ? `${Math.round(rect.x)}x${Math.round(rect.width)}` : ""
            stableFrames = ready && signature === lastSignature ? stableFrames + 1 : ready ? 1 : 0
            lastSignature = signature
            if (stableFrames >= 2) {
              recovered = true
              return resolve(elapsed)
            }
            if (elapsed >= timeoutMs) return resolve(elapsed)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        performance.clearMarks(mark)
        performance.clearMarks(closeMark)
        return {
          completionMs,
          acknowledgedMs,
          timedOut: completionMs >= timeoutMs,
          interruptOffsetMs: closedAt === undefined ? undefined : started - closedAt,
          recovered,
        }
      }, { mark: interruptReopenControl.mark, closeMark, timeoutMs })
    },
  )
  record("workspace_lifecycle_close_reopen_interrupt", closeReopenInterrupt.metric, closeReopenInterrupt.observation, [
    ...workspaceLifecycleInterruptionFailures("workspace_lifecycle_close_reopen_interrupt", closeReopenInterrupt.observation),
    ...alreadyLoadedResourceRequestFailures(
      "workspace_lifecycle_close_reopen_interrupt",
      isolatedInteractionResourceRequests(closeReopenInterrupt.metric),
    ),
  ])
  if (closeReopenInterrupt.observation.interruptOffsetMs !== undefined) {
    debug.push(measurement("workspace_lifecycle_close_reopen_interrupt_offset_ms", roundMs(closeReopenInterrupt.observation.interruptOffsetMs)))
  }
  await settleGate("workspace_lifecycle_close_reopen_interrupt")

  // Phase 6: warm-data / cold-surface reopen — close fully (crossing the
  // disposal boundary), then one trusted reopen with the caches warm; shell
  // and content are clocked separately. The request count is reported rather
  // than gated: whether a reopen revalidates warm data is exactly what this
  // phase exists to make visible.
  await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR)
  await waitForWorkspacePanelFullyClosed(page)
  await page.waitForTimeout(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS)
  await settleGate("workspace_lifecycle_before_warm_reopen")
  const warmReopenControl = await prepareTrustedInteraction(page, workspacePanelToggle(page), "workspace-lifecycle-warm-reopen")
  const warmReopen = await measureIsolatedInteraction<WorkspaceLifecycleWarmReopenObservation>(
    page,
    "workspace-lifecycle-warm-reopen",
    async () => {
      await page.mouse.click(warmReopenControl.x, warmReopenControl.y)
      return await page.evaluate(async ({ mark, timeoutMs, expectedTotal }) => {
        const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
        if (started === undefined) throw new Error("Trusted workspace warm reopen did not emit pointerdown")
        const visible = (element: Element) => {
          if (element.closest("[aria-hidden='true']")) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        }
        let acknowledgedMs: number | undefined
        let shellSettledMs: number | undefined
        let shellStableFrames = 0
        let lastShellSignature = ""
        let contentReadyMs: number | undefined
        let readyStableFrames = 0
        const completionMs = await new Promise<number>((resolve) => {
          const tick = () => {
            const elapsed = performance.now() - started
            const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
            if (acknowledgedMs === undefined && shell) acknowledgedMs = elapsed
            const shellVisible = !!shell && visible(shell) && shell.getBoundingClientRect().width > 120
            if (shellVisible && shellSettledMs === undefined) {
              const rect = shell.getBoundingClientRect()
              // approx: no shell/content split yet (see contract note).
              const signature = `${Math.round(rect.x)}x${Math.round(rect.width)}`
              shellStableFrames = signature === lastShellSignature ? shellStableFrames + 1 : 1
              lastShellSignature = signature
              if (shellStableFrames >= 2) shellSettledMs = elapsed
            }
            const root = shell
              ? Array.from(shell.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
              : undefined
            const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
            const rows = root ? Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]")).filter(visible) : []
            const pending = !!root?.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
            const contentReady = shellVisible && rows.length > 0 &&
              Number(corpus?.dataset.reviewTotalFiles ?? "0") === expectedTotal && !pending
            if (contentReady && contentReadyMs === undefined) contentReadyMs = elapsed
            const ready = contentReady && shellSettledMs !== undefined
            readyStableFrames = ready ? readyStableFrames + 1 : 0
            if (readyStableFrames >= 2 || elapsed >= timeoutMs) return resolve(elapsed)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        performance.clearMarks(mark)
        return {
          completionMs,
          acknowledgedMs,
          timedOut: completionMs >= timeoutMs,
          shellSettledMs,
          contentReadyMs,
        }
      }, { mark: warmReopenControl.mark, timeoutMs, expectedTotal })
    },
  )
  record("workspace_lifecycle_warm_reopen", warmReopen.metric, warmReopen.observation,
    workspaceLifecycleWarmReopenFailures(warmReopen.observation))
  debug.push(
    ...(warmReopen.observation.shellSettledMs !== undefined
      ? [measurement("workspace_lifecycle_warm_reopen_shell_ms", roundMs(warmReopen.observation.shellSettledMs))]
      : []),
    ...(warmReopen.observation.contentReadyMs !== undefined
      ? [measurement("workspace_lifecycle_warm_reopen_content_ms", roundMs(warmReopen.observation.contentReadyMs))]
      : []),
  )
  await settleGate("workspace_lifecycle_warm_reopen")

  // Phase 7: close with complete surface disposal — one trusted close, then
  // the ownership-zero inspection after the disposal dwell.
  const finalCloseControl = await prepareTrustedInteraction(page, workspacePanelToggle(page), "workspace-lifecycle-close")
  const finalClose = await measureIsolatedInteraction<IsolatedInteractionObservation>(
    page,
    "workspace-lifecycle-close",
    async () => {
      await page.mouse.click(finalCloseControl.x, finalCloseControl.y)
      return await page.evaluate(async ({ mark, timeoutMs }) => {
        const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
        if (started === undefined) throw new Error("Trusted workspace close did not emit pointerdown")
        let acknowledgedMs: number | undefined
        const completionMs = await new Promise<number>((resolve) => {
          const tick = () => {
            const elapsed = performance.now() - started
            const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
            if (acknowledgedMs === undefined && (!shell || shell.dataset.open === "false")) acknowledgedMs = elapsed
            const closed = !shell || (
              shell.dataset.open === "false" &&
              (shell.getAttribute("aria-hidden") === "true" || getComputedStyle(shell).display === "none")
            )
            if (closed || elapsed >= timeoutMs) return resolve(elapsed)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        performance.clearMarks(mark)
        return { completionMs, acknowledgedMs, timedOut: completionMs >= timeoutMs }
      }, { mark: finalCloseControl.mark, timeoutMs })
    },
  )
  record("workspace_lifecycle_close", finalClose.metric, finalClose.observation,
    alreadyLoadedResourceRequestFailures("workspace_lifecycle_close", isolatedInteractionResourceRequests(finalClose.metric)))
  await page.waitForTimeout(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS)
  const closedOwnership = await readWorkspaceClosedOwnership(page)
  debug.push(
    measurement("workspace_lifecycle_disposal_required", requireDisposal ? 1 : 0, "count"),
    ...workspaceOwnershipRows("workspace_lifecycle_closed_owned", closedOwnership),
  )
  if (requireDisposal) {
    for (const failure of heavyWorkspaceClosedOwnershipFailures(closedOwnership)) {
      recordVisualFailure(fixture, `workspace_lifecycle_close: ${failure}`)
    }
  }

  return { headline: mergeFrameMetrics("workspace-lifecycle", metrics), debug }
}

type PanelInteractionMode =
  | { kind: "activate-file"; filePath: string }
  | { kind: "activate-review" }
  | { kind: "diff-style"; expectedStyle: string }
  | { kind: "expand-diff"; filePath: string; renderedHunksBefore: number }
  // Collapse is structural: collapsed rows mount NO accordion content at all
  // (review-session.tsx wraps Content in Show when={expanded()}), and the
  // rendered-hunks counter is monotonic, so unmount + trigger state — not a
  // counter decrease — is the collapse observable.
  | { kind: "collapse-diff"; filePath: string }
  // An above-ceiling diff expands to the large-diff guard pane, not hunks.
  | { kind: "large-diff-guard"; filePath: string }
  // The "render anyway" force is its own isolated interaction and is where
  // the large hunks actually render.
  | { kind: "force-large-diff"; filePath: string; renderedHunksBefore: number }
  | { kind: "navigator"; expectedMode: "files" | "changes" }
  | { kind: "close-tab"; tabId: string; openTabsBefore: number }

type PanelInteractionObservation = IsolatedInteractionObservation & {
  tabs: WorkspaceTabSnapshot
  renderedHunks: number
  diffStyle?: string
  navigatorMode?: string
  navigatorDataReady: boolean
  /** For diff modes: the target row's trigger expanded state at settle. */
  rowExpanded: boolean
  /** For diff modes: the target row still mounts its diff wrapper at settle. */
  rowContentMounted: boolean
  /** For diff modes: the target row shows the large-diff guard pane at settle. */
  rowLargeDiffGuard: boolean
}

// One self-contained in-page readiness loop for every workspace-panel
// interaction kind. Serialized into the page by Playwright, so it must not
// reference module-scope helpers.
const observeWorkspacePanelInteraction = async (params: {
  mark: string
  timeoutMs: number
  expectedTotal: number
  mode: PanelInteractionMode
}): Promise<PanelInteractionObservation> => {
  const started = performance.getEntriesByName(params.mark, "mark").at(-1)?.startTime
  if (started === undefined) throw new Error(`Trusted ${params.mode.kind} interaction did not emit pointerdown`)
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
  const diffNode = () => {
    const node = reviewRoot()?.querySelector<HTMLElement>("[data-review-diff-style]")
    return node && !node.closest("[aria-hidden='true']") ? node : undefined
  }
  const renderedHunks = () => Number(diffNode()?.dataset.reviewRenderedHunks ?? "0")
  const tabsSnapshot = () => {
    const tabs = Array.from(shell()?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']") ?? [])
    return {
      openTabIds: tabs.map((tab) => tab.dataset.workspaceTabId ?? ""),
      activeTabId: tabs.find((tab) => tab.dataset.selected === "true")?.dataset.workspaceTabId,
    }
  }
  const loadingVisible = () => {
    const current = shell()
    if (!current) return false
    return Array.from(current.querySelectorAll<HTMLElement>("div, span"))
      .some((node) => visible(node) && node.children.length === 0 && node.textContent?.trim() === "Loading...")
  }
  const navigatorNode = () => {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator']"))
      .filter(visible)
      .at(-1)
  }
  const navigatorDataReady = () => {
    const navigator = navigatorNode()
    if (!navigator) return false
    if (navigator.getAttribute("data-file-tree-data-ready") === "true") return true
    if (navigator.querySelector("[data-file-tree-loading], [class*='animate-spin']")) return false
    return !!navigator.querySelector("[data-file-tree-path], [data-component='filetree'] button")
  }
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
      largeDiffGuard: !!row?.querySelector("[data-slot='session-review-large-diff']"),
    }
  }
  const acknowledge = (): boolean => {
    switch (mode.kind) {
      case "activate-file":
        return !!shell()?.querySelector(
          `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(mode.filePath)}"]`,
        )
      case "activate-review":
        return !!shell()?.querySelector(
          "[data-slot='workspace-tab'][data-workspace-tab-kind='review'][data-selected='true']",
        )
      case "diff-style":
        return diffNode()?.dataset.reviewDiffStyle === mode.expectedStyle
      case "expand-diff":
      case "large-diff-guard":
        return rowState().expanded
      case "collapse-diff":
        return !rowState().expanded
      case "force-large-diff":
        return !rowState().largeDiffGuard
      case "navigator":
        return navigatorNode()?.dataset.mode === mode.expectedMode
      case "close-tab":
        return tabsSnapshot().openTabIds.length < mode.openTabsBefore
    }
  }
  const ready = (): boolean => {
    switch (mode.kind) {
      case "activate-file": {
        const root = shell()?.querySelector<HTMLElement>(
          `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(mode.filePath)}"][data-tab-file-state='ready']`,
        )
        return !!root && visible(root) && !loadingVisible()
      }
      case "activate-review": {
        const root = reviewRoot()
        const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
        if (!corpus || Number(corpus.dataset.reviewTotalFiles ?? "0") !== params.expectedTotal) return false
        if (!Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? []).some(visible)) return false
        return !root?.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
      }
      case "diff-style":
        return diffNode()?.dataset.reviewDiffStyle === mode.expectedStyle
      case "expand-diff": {
        const state = rowState()
        return state.expanded && state.contentRendered && renderedHunks() > mode.renderedHunksBefore
      }
      case "collapse-diff": {
        const state = rowState()
        return !state.expanded && !state.contentMounted
      }
      case "large-diff-guard": {
        const state = rowState()
        return state.expanded && state.largeDiffGuard
      }
      case "force-large-diff": {
        const state = rowState()
        return state.expanded && !state.largeDiffGuard && state.contentRendered &&
          renderedHunks() > mode.renderedHunksBefore
      }
      case "navigator":
        return navigatorNode()?.dataset.mode === mode.expectedMode && navigatorDataReady()
      case "close-tab": {
        const tabs = tabsSnapshot()
        if (tabs.openTabIds.includes(mode.tabId)) return false
        if (tabs.openTabIds.length !== mode.openTabsBefore - 1) return false
        return tabs.activeTabId !== undefined && !loadingVisible()
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
      const signature = JSON.stringify([
        tabsSnapshot(),
        renderedHunks(),
        rowState(),
        diffNode()?.dataset.reviewDiffStyle,
        navigatorNode()?.dataset.mode,
      ])
      stableFrames = isReady && signature === lastSignature ? stableFrames + 1 : isReady ? 1 : 0
      lastSignature = signature
      if (stableFrames >= 2 || elapsed >= params.timeoutMs) return resolve(elapsed)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  performance.clearMarks(params.mark)
  const settledRowState = rowState()
  return {
    completionMs,
    acknowledgedMs,
    timedOut: completionMs >= params.timeoutMs,
    tabs: tabsSnapshot(),
    renderedHunks: renderedHunks(),
    diffStyle: diffNode()?.dataset.reviewDiffStyle,
    navigatorMode: navigatorNode()?.dataset.mode,
    navigatorDataReady: navigatorDataReady(),
    rowExpanded: settledRowState.expanded,
    rowContentMounted: settledRowState.contentMounted,
    rowLargeDiffGuard: settledRowState.largeDiffGuard,
  }
}

async function readWorkspaceTabSnapshot(page: Page): Promise<WorkspaceTabSnapshot> {
  return await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const tabs = Array.from(shell?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']") ?? [])
    return {
      openTabIds: tabs.map((tab) => tab.dataset.workspaceTabId ?? ""),
      activeTabId: tabs.find((tab) => tab.dataset.selected === "true")?.dataset.workspaceTabId,
    }
  })
}

async function workspaceInteractions(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const session = fixture.sessions[0]!
  await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)
  const expectedTotal = fixture.changedFiles.length
  const timeoutMs = ISOLATED_INTERACTION_TIMEOUT_MS
  const debug: Measurement[] = []
  const metrics: FrameMetric[] = []
  const settleGate = async (label: string) => {
    const gate = await settleBeforeNextInteraction(page)
    debug.push(
      measurement(`${label}_settle_gate_ms`, roundMs(gate.waitedMs)),
      measurement(`${label}_settle_gate_settled`, gate.settled ? 1 : 0, "count"),
    )
  }

  // Precondition for EVERY interaction: data loaded and animations settled.
  await openReviewSurface(page, fixture, { settle: "frame" })
  await waitForHeavyReviewCorpus(page, fixture)
  await measureWorkspaceFiles(page, fixture, { settle: "frame" })
  for (const filePath of WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS) {
    await openWorkspaceFileTab(page, fixture, filePath)
  }
  await settleGate("workspace_interactions_precondition")

  const tabIdForFile = async (filePath: string) =>
    await page.evaluate((basename) => {
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      const tabs = Array.from(
        shell?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab'][data-workspace-tab-kind='file']") ?? [],
      )
      return tabs.find((tab) => (tab.textContent ?? "").includes(basename))?.dataset.workspaceTabId
    }, path.basename(filePath))
  const fileTabButton = (filePath: string) =>
    page
      .locator("[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='file']")
      .filter({ hasText: path.basename(filePath) })
      .first()
      .locator("button")
      .first()
  const reviewTabButton = () =>
    page.locator(
      "[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='review'] button",
    ).first()
  const navigator = () => page.locator("[data-testid='workspace-files-navigator'][data-mode='files']").last()

  const runPanelInteraction = async (input: {
    prefix: string
    control: ReturnType<Page["locator"]>
    mode: PanelInteractionMode
    hardZeroRequests: boolean
    /**
     * Rest the pointer on the control for this long before the measured press.
     * `page.mouse.click` moves and presses in the same call, which no mouse
     * user can do: reaching a control and committing to it takes longer than a
     * frame. Use it only where the dwell is part of the interaction being
     * modelled, and keep it out of the measured window (the recorder arms at
     * the trusted pointerdown, so hover-time work is excluded by construction).
     */
    hoverDwellMs?: number
  }) => {
    await input.control.scrollIntoViewIfNeeded().catch(() => undefined)
    const prepared = await prepareTrustedInteraction(page, input.control, input.prefix)
    if (input.hoverDwellMs) {
      await page.mouse.move(prepared.x, prepared.y)
      await page.waitForTimeout(input.hoverDwellMs)
    }
    const { metric, observation } = await measureIsolatedInteraction<PanelInteractionObservation>(
      page,
      input.prefix,
      async () => {
        await page.mouse.click(prepared.x, prepared.y)
        return await page.evaluate(observeWorkspacePanelInteraction, {
          mark: prepared.mark,
          timeoutMs,
          expectedTotal,
          mode: input.mode,
        })
      },
    )
    metrics.push(metric)
    debug.push(...isolatedInteractionMetricRows(input.prefix, metric, observation))
    for (const failure of [
      ...isolatedInteractionEvidenceFailures(input.prefix, metric),
      ...isolatedInteractionSettleFailures(input.prefix, observation),
      ...(input.hardZeroRequests
        ? alreadyLoadedResourceRequestFailures(input.prefix, isolatedInteractionResourceRequests(metric))
        : []),
    ]) recordVisualFailure(fixture, failure)
    await settleGate(input.prefix)
    return { metric, observation }
  }

  const [fileA, fileB] = WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS
  const readRenderedHunks = async () =>
    await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll<HTMLElement>("[data-review-diff-style]"))
        .find((item) => !item.closest("[aria-hidden='true']"))
      return Number(node?.dataset.reviewRenderedHunks ?? "0")
    })
  const readDiffStyle = async () =>
    await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll<HTMLElement>("[data-review-diff-style]"))
        .find((item) => !item.closest("[aria-hidden='true']"))
      return node?.dataset.reviewDiffStyle
    })
  const gateTabSwitch = (interaction: string, before: WorkspaceTabSnapshot, after: WorkspaceTabSnapshot, expectedActiveTabId?: string) => {
    for (const failure of workspaceInteractionTabSwitchFailures({ interaction, before, after, expectedActiveTabId })) {
      recordVisualFailure(fixture, failure)
    }
  }

  // Switching among open file tabs — both directions, each isolated + zero requests.
  const tabIdA = await tabIdForFile(fileA!)
  const tabIdB = await tabIdForFile(fileB!)
  let before = await readWorkspaceTabSnapshot(page)
  const toA = await runPanelInteraction({
    prefix: "workspace_interactions_tab_switch_to_a",
    control: fileTabButton(fileA!),
    mode: { kind: "activate-file", filePath: fileA! },
    hardZeroRequests: true,
  })
  gateTabSwitch("workspace_interactions_tab_switch_to_a", before, toA.observation.tabs, tabIdA)
  before = toA.observation.tabs
  const toB = await runPanelInteraction({
    prefix: "workspace_interactions_tab_switch_to_b",
    control: fileTabButton(fileB!),
    mode: { kind: "activate-file", filePath: fileB! },
    hardZeroRequests: true,
  })
  gateTabSwitch("workspace_interactions_tab_switch_to_b", before, toB.observation.tabs, tabIdB)

  // Files -> Review navigation (data already loaded at precondition).
  before = toB.observation.tabs
  const toReview = await runPanelInteraction({
    prefix: "workspace_interactions_files_to_review",
    control: reviewTabButton(),
    mode: { kind: "activate-review" },
    hardZeroRequests: true,
  })
  gateTabSwitch("workspace_interactions_files_to_review", before, toReview.observation.tabs)

  // Expanding then collapsing a substantial diff — the SAME row both times,
  // addressed through its own trigger. Expanding may legitimately fetch the
  // file diff on demand, so its request count is reported, not gated;
  // collapsing unmounts already-mounted DOM and is a hard zero. Collapse is
  // proven structurally (content unmounted): the rendered-hunks counter is
  // the app's monotonic render counter and never decreases.
  const expandPath = fixture.changedFiles[WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX]!.file
  const diffTrigger = page
    .locator(`[data-testid='review-pane-root'] [data-review-file="${expandPath}"]`)
    .locator("[data-testid$='-trigger']")
    .first()
  const hunksBeforeExpand = await readRenderedHunks()
  const expand = await runPanelInteraction({
    prefix: "workspace_interactions_diff_expand",
    control: diffTrigger,
    mode: { kind: "expand-diff", filePath: expandPath, renderedHunksBefore: hunksBeforeExpand },
    hardZeroRequests: false,
    // A row is expanded with a mouse, and a mouse cannot press a row it has not
    // first moved onto and held still on. Modelling that dwell is the only way
    // this phase measures what a user experiences: without it the pointer
    // arrives and presses in the same task, so anything the app starts at hover
    // time (here: the row's diff content) is still in flight when the press
    // begins and gets charged to the click. The dwell is deliberately short —
    // well under the ~200ms a deliberate click takes end to end.
    hoverDwellMs: WORKSPACE_INTERACTIONS_HOVER_DWELL_MS,
  })
  for (const failure of workspaceInteractionExpandFailures({
    interaction: "workspace_interactions_diff_expand",
    renderedHunksBefore: hunksBeforeExpand,
    renderedHunksAfter: expand.observation.renderedHunks,
  })) recordVisualFailure(fixture, failure)
  const collapse = await runPanelInteraction({
    prefix: "workspace_interactions_diff_collapse",
    control: diffTrigger,
    mode: { kind: "collapse-diff", filePath: expandPath },
    hardZeroRequests: true,
  })
  for (const failure of workspaceInteractionCollapseFailures({
    interaction: "workspace_interactions_diff_collapse",
    stillExpanded: collapse.observation.rowExpanded,
    contentMounted: collapse.observation.rowContentMounted,
  })) recordVisualFailure(fixture, failure)

  // Split <-> unified, both directions, each isolated + zero requests.
  const initialStyle = await readDiffStyle()
  if (initialStyle !== "split" && initialStyle !== "unified") {
    recordVisualFailure(fixture, `review diff style was not readable before the toggle: ${String(initialStyle)}`)
  } else {
    const otherStyle = initialStyle === "split" ? "unified" : "split"
    for (const [prefix, expectedStyle] of [
      ["workspace_interactions_diff_style_forward", otherStyle],
      ["workspace_interactions_diff_style_back", initialStyle],
    ] as const) {
      const toggle = page
        .locator(`[data-testid="review-diff-style-toggle"][data-review-next-diff-style="${expectedStyle}"]`)
        .last()
      const result = await runPanelInteraction({
        prefix,
        control: toggle,
        mode: { kind: "diff-style", expectedStyle },
        hardZeroRequests: true,
      })
      for (const failure of workspaceInteractionDiffStyleFailures({
        interaction: prefix,
        expectedStyle,
        observedStyle: result.observation.diffStyle,
      })) recordVisualFailure(fixture, failure)
    }
  }

  // Large-diff expand: the diff's changed lines exceed the app's render
  // ceiling (MAX_DIFF_CHANGED_LINES), so it is measured as TWO isolated
  // interactions — expanding surfaces the large-diff guard pane (the app's
  // designed above-ceiling response, no hunks and no content fetch), and the
  // explicit "render anyway" force then renders the large hunks (fetching
  // content on demand, so its request count is reported, not gated).
  const largeDiffPath = fixture.changedFiles[WORKSPACE_INTERACTIONS_LARGE_DIFF_INDEX]!.file
  const largeDiffTrigger = page
    .locator(`[data-testid='review-pane-root'] [data-review-file="${largeDiffPath}"]`)
    .locator("[data-testid$='-trigger']")
    .first()
  const largeGuard = await runPanelInteraction({
    prefix: "workspace_interactions_large_diff_expand",
    control: largeDiffTrigger,
    mode: { kind: "large-diff-guard", filePath: largeDiffPath },
    hardZeroRequests: false,
  })
  for (const failure of workspaceInteractionLargeDiffGuardFailures({
    interaction: "workspace_interactions_large_diff_expand",
    placeholderShown: largeGuard.observation.rowLargeDiffGuard,
  })) recordVisualFailure(fixture, failure)
  if (largeGuard.observation.rowLargeDiffGuard) {
    const hunksBeforeForce = await readRenderedHunks()
    const forceButton = page
      .locator(`[data-testid='review-pane-root'] [data-review-file="${largeDiffPath}"] [data-slot='session-review-large-diff-actions'] button`)
      .first()
    const force = await runPanelInteraction({
      prefix: "workspace_interactions_large_diff_force",
      control: forceButton,
      mode: { kind: "force-large-diff", filePath: largeDiffPath, renderedHunksBefore: hunksBeforeForce },
      hardZeroRequests: false,
    })
    for (const failure of workspaceInteractionExpandFailures({
      interaction: "workspace_interactions_large_diff_force",
      renderedHunksBefore: hunksBeforeForce,
      renderedHunksAfter: force.observation.renderedHunks,
    })) recordVisualFailure(fixture, failure)
  }

  // Review -> Files navigation back onto an open, already-loaded file tab.
  before = await readWorkspaceTabSnapshot(page)
  const backToFiles = await runPanelInteraction({
    prefix: "workspace_interactions_review_to_files",
    control: fileTabButton(fileB!),
    mode: { kind: "activate-file", filePath: fileB! },
    hardZeroRequests: true,
  })
  gateTabSwitch("workspace_interactions_review_to_files", before, backToFiles.observation.tabs, tabIdB)

  // Navigator mode change, both directions. The changes mode may fetch VCS
  // status on demand, so both directions report rather than gate requests.
  // The Changes navigator button is configuration-gated (showChanges); when
  // this build does not render it, the interaction is skipped and reported.
  const changesAvailable = await page.locator("button[aria-label='Open Changes']:visible").count()
  debug.push(measurement("workspace_interactions_navigator_changes_available", changesAvailable > 0 ? 1 : 0, "count"))
  if (changesAvailable > 0) {
    for (const [prefix, label, expectedMode] of [
      ["workspace_interactions_navigator_to_changes", "Open Changes", "changes"],
      ["workspace_interactions_navigator_to_files", "Open Files", "files"],
    ] as const) {
      const result = await runPanelInteraction({
        prefix,
        control: page.locator(`button[aria-label='${label}']:visible`).first(),
        mode: { kind: "navigator", expectedMode },
        hardZeroRequests: false,
      })
      for (const failure of workspaceInteractionNavigatorFailures({
        interaction: prefix,
        expectedMode,
        observedMode: result.observation.navigatorMode,
        dataReady: result.observation.navigatorDataReady,
      })) recordVisualFailure(fixture, failure)
    }
  }

  // Opening a file (fetches content on demand -> requests reported).
  const searchAndRow = async (filePath: string) => {
    const search = navigator().locator("input[placeholder='Search files...']").first()
    await search.fill(filePath)
    const row = navigator().locator(`[data-file-tree-path="${filePath}"]`).first()
    await row.waitFor({ state: "visible", timeout: 3_000 })
    return row
  }
  before = await readWorkspaceTabSnapshot(page)
  const openRow = await searchAndRow(WORKSPACE_INTERACTIONS_OPEN_FILE_PATH)
  const openFile = await runPanelInteraction({
    prefix: "workspace_interactions_open_file",
    control: openRow,
    mode: { kind: "activate-file", filePath: WORKSPACE_INTERACTIONS_OPEN_FILE_PATH },
    hardZeroRequests: false,
  })
  for (const failure of workspaceInteractionTabDeltaFailures({
    interaction: "workspace_interactions_open_file",
    before,
    after: openFile.observation.tabs,
    expectedDelta: 1,
  })) recordVisualFailure(fixture, failure)

  // Closing that file (already loaded -> hard zero).
  const closeTabId = await tabIdForFile(WORKSPACE_INTERACTIONS_OPEN_FILE_PATH)
  if (!closeTabId) {
    recordVisualFailure(fixture, `workspace_interactions_close_file: no tab id for ${WORKSPACE_INTERACTIONS_OPEN_FILE_PATH}`)
  } else {
    before = await readWorkspaceTabSnapshot(page)
    const closeFile = await runPanelInteraction({
      prefix: "workspace_interactions_close_file",
      control: page
        .locator(`[data-testid='workspace-tab-close'][data-workspace-tab-id="${closeTabId}"]`)
        .locator("button")
        .first(),
      mode: { kind: "close-tab", tabId: closeTabId, openTabsBefore: before.openTabIds.length },
      hardZeroRequests: true,
    })
    for (const failure of workspaceInteractionTabDeltaFailures({
      interaction: "workspace_interactions_close_file",
      before,
      after: closeFile.observation.tabs,
      expectedDelta: -1,
    })) recordVisualFailure(fixture, failure)
  }

  // Panel resize: a trusted pointer drag on the resize separator, dragged in
  // the NARROWING direction (+x on the left-edge handle). Widening from the
  // ~70% default immediately hits the panel's readable-content clamp
  // (maxWidth = min(86% of available, available - reserved content width)),
  // which would truncate the drag; narrowing has 400+px of unclamped travel
  // above the 360px minimum. Deliberately measured BEFORE the large-file
  // open: each drag step re-lays-out the active tab at the new width, and
  // dragging a 3200-line file saturated the renderer far past the readiness
  // bound — the resize interaction measures the panel's resize path against a
  // standard-weight tab, while the large file's cost stays owned by its own
  // interaction. The completion clock includes the scripted drag itself; the
  // renderer-interval distribution during the drag is the real signal. Hard
  // zero requests.
  const widthBefore = await page.evaluate(() =>
    document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      ?.getBoundingClientRect().width ?? 0)
  const separator = page.locator("[role='separator'][aria-label='Resize workspace panel']").first()
  const resizePrepared = await prepareTrustedInteraction(page, separator, "workspace_interactions_panel_resize")
  const resize = await measureIsolatedInteraction<IsolatedInteractionObservation & { widthAfter: number }>(
    page,
    "workspace-interactions-panel-resize",
    async () => {
      await page.mouse.move(resizePrepared.x, resizePrepared.y)
      await page.mouse.down()
      for (let step = 1; step <= 8; step++) {
        await page.mouse.move(resizePrepared.x + (WORKSPACE_INTERACTIONS_RESIZE_DELTA_PX * step) / 8, resizePrepared.y)
      }
      await page.mouse.up()
      return await page.evaluate(async ({ mark, timeoutMs, widthBefore }) => {
        const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
        if (started === undefined) throw new Error("Trusted panel resize did not emit pointerdown")
        const width = () =>
          document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
            ?.getBoundingClientRect().width ?? 0
        let acknowledgedMs: number | undefined
        let stableFrames = 0
        let lastWidth = -1
        const completionMs = await new Promise<number>((resolve) => {
          const tick = () => {
            const elapsed = performance.now() - started
            const current = width()
            if (acknowledgedMs === undefined && Math.abs(current - widthBefore) > 0.5) acknowledgedMs = elapsed
            const moved = Math.abs(current - widthBefore) > 0.5
            stableFrames = moved && Math.abs(current - lastWidth) <= 0.5 ? stableFrames + 1 : moved ? 1 : 0
            lastWidth = current
            if (stableFrames >= 2 || elapsed >= timeoutMs) return resolve(elapsed)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        performance.clearMarks(mark)
        return { completionMs, acknowledgedMs, timedOut: completionMs >= timeoutMs, widthAfter: width() }
      }, { mark: resizePrepared.mark, timeoutMs, widthBefore })
    },
  )
  metrics.push(resize.metric)
  debug.push(
    ...isolatedInteractionMetricRows("workspace_interactions_panel_resize", resize.metric, resize.observation),
    measurement("workspace_interactions_panel_resize_width_delta_px", roundMs(resize.observation.widthAfter - widthBefore), "px"),
  )
  for (const failure of [
    ...isolatedInteractionEvidenceFailures("workspace_interactions_panel_resize", resize.metric),
    ...isolatedInteractionSettleFailures("workspace_interactions_panel_resize", resize.observation),
    ...alreadyLoadedResourceRequestFailures(
      "workspace_interactions_panel_resize",
      isolatedInteractionResourceRequests(resize.metric),
    ),
    ...workspaceInteractionResizeFailures({ widthBefore, widthAfter: resize.observation.widthAfter }),
  ]) recordVisualFailure(fixture, failure)
  await settleGate("workspace_interactions_panel_resize")

  // Large-file open: much larger than the median opened file. Last, so its
  // heavyweight surface cannot bleed into any later interaction's clock.
  before = await readWorkspaceTabSnapshot(page)
  const largeRow = await searchAndRow(WORKSPACE_INTERACTIONS_LARGE_FILE_PATH)
  const openLargeFile = await runPanelInteraction({
    prefix: "workspace_interactions_open_large_file",
    control: largeRow,
    mode: { kind: "activate-file", filePath: WORKSPACE_INTERACTIONS_LARGE_FILE_PATH },
    hardZeroRequests: false,
  })
  for (const failure of workspaceInteractionTabDeltaFailures({
    interaction: "workspace_interactions_open_large_file",
    before,
    after: openLargeFile.observation.tabs,
    expectedDelta: 1,
  })) recordVisualFailure(fixture, failure)

  return { headline: mergeFrameMetrics("workspace-interactions", metrics), debug }
}

type SessionSwitchObservation = IsolatedInteractionObservation & {
  sessionReadyMs?: number
  oldWorkspaceReleasedMs?: number
  oldWorkspaceRelease?: OldWorkspaceRelease
  destinationWorkspaceReadyMs?: number
}

// Self-contained in-page loop: destination-session readiness only (used when
// the workspace panel is a bystander or closed).
const observeSessionSwitchReady = async (params: {
  mark: string
  timeoutMs: number
  sessionId: string
}): Promise<SessionSwitchObservation> => {
  const started = performance.getEntriesByName(params.mark, "mark").at(-1)?.startTime
  if (started === undefined) throw new Error(`Trusted session switch did not emit pointerdown for ${params.sessionId}`)
  const root = () =>
    document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(params.sessionId)}"]`)
  const sessionReady = () => {
    const target = root()
    if (!target || target.closest("[aria-hidden='true']")) return false
    if (target.dataset.sessionFirstFoldReady !== "true" || target.dataset.sessionMessagesReady !== "true") return false
    if (Number(target.dataset.sessionMessageCount ?? target.dataset.sessionConversationCount ?? "0") <= 0) return false
    const timeline = target.querySelector<HTMLElement>("[data-session-timeline-root]")
    if (!timeline || timeline.dataset.sessionTimelineRevealReady !== "true") return false
    if (timeline.dataset.sessionTimelineProgressiveReady !== "true") return false
    if (getComputedStyle(timeline).visibility === "hidden") return false
    if (Number(timeline.dataset.sessionTimelineKeyCount ?? "0") <= 0) return false
    return Array.from(timeline.querySelectorAll<HTMLElement>("[data-timeline-key]"))
      .some((row) => (row.textContent ?? "").trim())
  }
  let acknowledgedMs: number | undefined
  let sessionReadyMs: number | undefined
  let stableFrames = 0
  const completionMs = await new Promise<number>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - started
      if (acknowledgedMs === undefined && root()) acknowledgedMs = elapsed
      const ready = sessionReady()
      if (ready && sessionReadyMs === undefined) sessionReadyMs = elapsed
      stableFrames = ready ? stableFrames + 1 : 0
      if (stableFrames >= 2 || elapsed >= params.timeoutMs) return resolve(elapsed)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  performance.clearMarks(params.mark)
  return { completionMs, acknowledgedMs, timedOut: completionMs >= params.timeoutMs, sessionReadyMs }
}

// Self-contained in-page loop for a cross-workspace switch with the panel
// open: one click, independent clocks for destination-session readiness, old
// workspace disposal, and destination workspace above-fold readiness (shell
// responsiveness — the fourth clock — is the interaction's renderer-interval
// distribution, captured by the recorder).
const observeCrossWorkspaceSessionSwitch = async (params: {
  mark: string
  timeoutMs: number
  sessionId: string
  newDirectory: string
  oldDirectory: string
  expectedTotal: number
  /** RETAINED_PANEL_BODY_HOST_SELECTOR — the contract owns the marker names. */
  bodyHostSelector: string
  /** RETAINED_PANEL_BODY_INERT_ATTRIBUTE. */
  bodyInertAttribute: string
}): Promise<SessionSwitchObservation> => {
  const started = performance.getEntriesByName(params.mark, "mark").at(-1)?.startTime
  if (started === undefined) throw new Error(`Trusted cross-workspace switch did not emit pointerdown for ${params.sessionId}`)
  const visible = (element: Element) => {
    if (element.closest("[aria-hidden='true']")) return false
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const root = () =>
    document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(params.sessionId)}"]`)
  const sessionReady = () => {
    const target = root()
    if (!target || target.closest("[aria-hidden='true']")) return false
    if (target.dataset.sessionFirstFoldReady !== "true" || target.dataset.sessionMessagesReady !== "true") return false
    if (Number(target.dataset.sessionMessageCount ?? target.dataset.sessionConversationCount ?? "0") <= 0) return false
    const timeline = target.querySelector<HTMLElement>("[data-session-timeline-root]")
    if (!timeline || timeline.dataset.sessionTimelineRevealReady !== "true") return false
    if (timeline.dataset.sessionTimelineProgressiveReady !== "true") return false
    if (getComputedStyle(timeline).visibility === "hidden") return false
    if (Number(timeline.dataset.sessionTimelineKeyCount ?? "0") <= 0) return false
    return Array.from(timeline.querySelectorAll<HTMLElement>("[data-timeline-key]"))
      .some((row) => (row.textContent ?? "").trim())
  }
  const shell = () => document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
  const oldContent = (window as unknown as { __claxedoPerfOldPanelContent?: HTMLElement }).__claxedoPerfOldPanelContent
  // The old surface stops being the user's surface either by leaving the
  // document, or by being retained under a body host the panel has PROVED
  // inert: marked not-displayed, hidden from the accessibility tree, and
  // skipped for rendering. Anything less (still marked displayed, still
  // reachable, still rendering) is not a release. Mirrors the retained-Review
  // reader used by the heavy-workspace inactive-ownership gate.
  const readOldWorkspaceRelease = (): OldWorkspaceRelease | undefined => {
    if (!oldContent) return undefined
    if (!oldContent.isConnected) return "disposed"
    const host = oldContent.closest<HTMLElement>(params.bodyHostSelector)
    if (!host) return undefined
    const inert = host.getAttribute(params.bodyInertAttribute) === "true" &&
      host.getAttribute("aria-hidden") === "true" &&
      getComputedStyle(host).contentVisibility === "hidden"
    return inert ? "retained-inert" : undefined
  }
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
  let oldWorkspaceReleasedMs: number | undefined
  let oldWorkspaceRelease: OldWorkspaceRelease | undefined
  let destinationWorkspaceReadyMs: number | undefined
  let stableFrames = 0
  const completionMs = await new Promise<number>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - started
      if (acknowledgedMs === undefined && root()) acknowledgedMs = elapsed
      if (sessionReadyMs === undefined && sessionReady()) sessionReadyMs = elapsed
      if (oldWorkspaceReleasedMs === undefined) {
        const release = readOldWorkspaceRelease()
        if (release) {
          oldWorkspaceRelease = release
          oldWorkspaceReleasedMs = elapsed
        }
      }
      if (destinationWorkspaceReadyMs === undefined && destinationReady()) destinationWorkspaceReadyMs = elapsed
      const done = sessionReadyMs !== undefined && oldWorkspaceReleasedMs !== undefined && destinationWorkspaceReadyMs !== undefined
      stableFrames = done ? stableFrames + 1 : 0
      if (stableFrames >= 2 || elapsed >= params.timeoutMs) return resolve(elapsed)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  performance.clearMarks(params.mark)
  delete (window as unknown as { __claxedoPerfOldPanelContent?: HTMLElement }).__claxedoPerfOldPanelContent
  return {
    completionMs,
    acknowledgedMs,
    timedOut: completionMs >= params.timeoutMs,
    sessionReadyMs,
    oldWorkspaceReleasedMs,
    oldWorkspaceRelease,
    destinationWorkspaceReadyMs,
  }
}

const SESSION_SWITCH_PANEL_CONTENT_SELECTOR = "[data-testid='review-pane-root']"

async function sessionSwitchWorkspace(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const sessions = fixture.sessions
  const home = sessions[0]!
  await launchTo(page, app, sessionPath(home, home.id))
  await waitForTranscript(page, fixture, home.id, home.title)
  await showSessionInventory(page, fixture, Math.min(sessions.length, 8), { settle: "frame" })
  const expectedTotal = fixture.changedFiles.length
  const timeoutMs = ISOLATED_INTERACTION_TIMEOUT_MS
  const debug: Measurement[] = []
  const metrics: FrameMetric[] = []
  const completions = new Map<string, number>()
  const settleStabilityRequestStarts = async (label: string) => {
    const started = performance.now()
    let quietStarted = started
    let previous = { ...fixture.requestCounts.stability }
    // Boot and workspace setup intentionally start the authoritative workspace
    // resolve/VCS/file queries. Do not charge a query whose request begins
    // after the surface is visually ready to the first session click. Use
    // elapsed time rather than a frame count: headless Chromium can deliver
    // rAF callbacks much faster than a physical display. The 300ms quiet
    // interval covers the file-status debounce after opening the substantial
    // file without entering any measured interaction window.
    while (performance.now() - quietStarted < 300 && performance.now() - started < 2_000) {
      await waitForAnimationFrame(page, 1)
      const current = fixture.requestCounts.stability
      const changed = current.vcs !== previous.vcs ||
        current.file !== previous.file ||
        current.workspace !== previous.workspace
      if (changed) quietStarted = performance.now()
      previous = { ...current }
    }
    debug.push(
      measurement(`${label}_request_quiet_gate_ms`, roundMs(performance.now() - started)),
      measurement(
        `${label}_request_quiet_gate_settled`,
        performance.now() - quietStarted >= 300 ? 1 : 0,
        "count",
      ),
    )
  }
  const settleGate = async (label: string) => {
    const gate = await settleBeforeNextInteraction(page)
    debug.push(
      measurement(`${label}_settle_gate_ms`, roundMs(gate.waitedMs)),
      measurement(`${label}_settle_gate_settled`, gate.settled ? 1 : 0, "count"),
    )
  }

  const sessionRowActivate = async (target: (typeof sessions)[number]) => {
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
    }, SESSION_SWITCH_PANEL_CONTENT_SELECTOR)
  }

  const readWorkspaceIdentity = async () => {
    return await page.evaluate((contentSelector) => {
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
        shellTokenPreserved: shell
          ? (shell as unknown as Record<string, unknown>).__claxedoPerfShellToken === true
          : false,
        contentTokenPreserved: content
          ? (content as unknown as Record<string, unknown>).__claxedoPerfContentToken === true
          : false,
        reviewRenderedFilesChurn: w.__claxedoPerfReviewChurn ?? 0,
      }
    }, SESSION_SWITCH_PANEL_CONTENT_SELECTOR)
  }

  const runCell = async (input: {
    block: SessionSwitchBlock
    scope: SessionSwitchScope
    temperature: SessionSwitchTemperature
    target: (typeof sessions)[number]
    panelOpen: boolean
    gateReviewChurn?: boolean
  }) => {
    const cell = sessionSwitchCellPrefix(input.block, input.scope, input.temperature)
    if (input.panelOpen) await stampWorkspaceIdentity()
    const requestsBefore = { ...fixture.requestCounts.stability }
    const premounted = await page
      .locator(`[data-testid="session-page-root"][data-session-id="${input.target.id}"]`)
      .count()
    const control = await sessionRowActivate(input.target)
    await control.scrollIntoViewIfNeeded().catch(() => undefined)
    const prepared = await prepareTrustedInteraction(page, control, cell)
    const oldDirectory = input.panelOpen
      ? await page.evaluate(() =>
          document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")?.dataset.stateWorkspaceDir ?? "")
      : ""
    const cross = input.scope === "across" && input.panelOpen
    const { metric, observation } = await measureIsolatedInteraction<SessionSwitchObservation>(page, cell, async () => {
      await page.mouse.click(prepared.x, prepared.y)
      return cross
        ? await page.evaluate(observeCrossWorkspaceSessionSwitch, {
            mark: prepared.mark,
            timeoutMs,
            sessionId: input.target.id,
            newDirectory: input.target.directory,
            oldDirectory,
            expectedTotal,
            bodyHostSelector: RETAINED_PANEL_BODY_HOST_SELECTOR,
            bodyInertAttribute: RETAINED_PANEL_BODY_INERT_ATTRIBUTE,
          })
        : await page.evaluate(observeSessionSwitchReady, {
            mark: prepared.mark,
            timeoutMs,
            sessionId: input.target.id,
          })
    })
    metrics.push(metric)
    completions.set(`${input.block}:${input.scope}:${input.temperature}`, observation.completionMs)
    debug.push(
      ...isolatedInteractionMetricRows(cell, metric, observation),
      measurement(`${cell}_destination_premounted`, premounted > 0 ? 1 : 0, "count"),
    )
    // Session readiness is measured independently of workspace readiness.
    if (observation.sessionReadyMs !== undefined) {
      debug.push(measurement(`${cell}_session_ready_ms`, roundMs(observation.sessionReadyMs)))
    }
    if (cross) {
      if (observation.oldWorkspaceReleasedMs !== undefined) {
        debug.push(
          measurement(`${cell}_old_workspace_released_ms`, roundMs(observation.oldWorkspaceReleasedMs)),
          // Which of the two releases it was: 0 = disposed, 1 = retained
          // inert. That is the difference between reconstructing the old body
          // on a return switch and flipping its display locks.
          measurement(`${cell}_old_workspace_retained_inert`, observation.oldWorkspaceRelease === "retained-inert" ? 1 : 0, "count"),
        )
      }
      if (observation.destinationWorkspaceReadyMs !== undefined) {
        debug.push(measurement(`${cell}_destination_workspace_ready_ms`, roundMs(observation.destinationWorkspaceReadyMs)))
      }
      for (const failure of crossWorkspaceSwitchClockFailures(cell, observation)) recordVisualFailure(fixture, failure)
    } else if (observation.sessionReadyMs === undefined) {
      recordVisualFailure(fixture, `${cell} destination session never became ready`)
    }
    await settleGate(cell)
    const requestDelta: StabilityRequestCounts = {
      vcs: fixture.requestCounts.stability.vcs - requestsBefore.vcs,
      file: fixture.requestCounts.stability.file - requestsBefore.file,
      workspace: fixture.requestCounts.stability.workspace - requestsBefore.workspace,
      sse: fixture.requestCounts.stability.sse - requestsBefore.sse,
    }
    debug.push(
      measurement(`${cell}_vcs_requests`, requestDelta.vcs, "count"),
      measurement(`${cell}_file_requests`, requestDelta.file, "count"),
      measurement(`${cell}_workspace_requests`, requestDelta.workspace, "count"),
      measurement(`${cell}_sse_reconnects`, requestDelta.sse, "count"),
    )
    const identity = input.panelOpen ? await readWorkspaceIdentity() : undefined
    if (input.scope === "within") {
      for (const failure of sameWorkspaceSwitchStabilityFailures(cell, {
        shellTokenPreserved: identity?.shellTokenPreserved,
        contentTokenPreserved: identity?.contentTokenPreserved,
        requestDelta,
        reviewRenderedFilesChurn: input.gateReviewChurn ? identity?.reviewRenderedFilesChurn : undefined,
      })) recordVisualFailure(fixture, failure)
    }
    for (const failure of [
      ...isolatedInteractionEvidenceFailures(cell, metric),
      ...isolatedInteractionSettleFailures(cell, observation),
    ]) recordVisualFailure(fixture, failure)
  }

  // Block A — workspace closed.
  await settleStabilityRequestStarts("session_switch_closed_precondition")
  await runCell({ block: "closed", scope: "within", temperature: "cold", target: sessions[2]!, panelOpen: false })
  await runCell({ block: "closed", scope: "within", temperature: "warm", target: home, panelOpen: false })
  await runCell({ block: "closed", scope: "across", temperature: "cold", target: sessions[1]!, panelOpen: false })
  await runCell({ block: "closed", scope: "across", temperature: "warm", target: home, panelOpen: false })

  // Block B — workspace open on a substantial file.
  await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR)
  await waitForWorkspaceReviewContent(page, expectedTotal)
  await measureWorkspaceFiles(page, fixture, { settle: "frame" })
  await openWorkspaceFileTab(page, fixture, SESSION_SWITCH_SUBSTANTIAL_FILE_PATH)
  await settleGate("session_switch_open_file_precondition")
  await settleStabilityRequestStarts("session_switch_open_file_precondition")
  await runCell({ block: "open_file", scope: "within", temperature: "cold", target: sessions[4]!, panelOpen: true })
  await runCell({ block: "open_file", scope: "within", temperature: "warm", target: home, panelOpen: true })
  await runCell({ block: "open_file", scope: "across", temperature: "cold", target: sessions[3]!, panelOpen: true })
  await runCell({ block: "open_file", scope: "across", temperature: "warm", target: home, panelOpen: true })

  // Block C — workspace open on a large review (500-file corpus, one
  // substantial diff expanded).
  // `> button` scopes to the tab's activate button; a bare `button` would
  // also match the nested close IconButton and `.at(-1)` would close the tab.
  await syntheticVisibleClick(
    page,
    "[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='review'] > button",
  )
  await waitForWorkspaceReviewContent(page, expectedTotal)
  await openFirstReviewDiff(page)
  await waitForReviewStable(page)
  await settleGate("session_switch_open_review_precondition")
  await settleStabilityRequestStarts("session_switch_open_review_precondition")
  await runCell({ block: "open_review", scope: "within", temperature: "cold", target: sessions[6]!, panelOpen: true, gateReviewChurn: true })
  await runCell({ block: "open_review", scope: "within", temperature: "warm", target: home, panelOpen: true, gateReviewChurn: true })
  await runCell({ block: "open_review", scope: "across", temperature: "cold", target: sessions[5]!, panelOpen: true })
  await runCell({ block: "open_review", scope: "across", temperature: "warm", target: home, panelOpen: true })

  // The workspace-open penalty, first-class per {within/across}x{cold/warm}
  // cell and per open variant.
  for (const block of ["open_file", "open_review"] as const) {
    for (const scope of SESSION_SWITCH_SCOPES) {
      for (const temperature of SESSION_SWITCH_TEMPERATURES) {
        const openMs = completions.get(`${block}:${scope}:${temperature}`)
        const closedMs = completions.get(`closed:${scope}:${temperature}`)
        if (openMs !== undefined && closedMs !== undefined) {
          debug.push(measurement(
            sessionSwitchPenaltyMetricName(block, scope, temperature),
            workspaceOpenPenaltyMs({ openMs, closedMs }),
          ))
        }
      }
    }
  }

  return { headline: mergeFrameMetrics("session-switch-workspace", metrics), debug }
}

function roundMs(value: number) {
  return Math.round(value * 100) / 100
}

export async function launchTo(page: Page, app: BrowserTarget, pathName: string) {
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

async function waitForSessionComposer(page: Page) {
  // The route fixture does not synthesize provider readiness, so PromptInput
  // may legitimately show its loading body. The dock still proves that the
  // lazy composer module evaluated, mounted, and established its interaction
  // region before the launch recorder stops.
  await page.waitForSelector("[data-component='session-prompt-dock']", { timeout: 10_000 })
}

export async function installSeedState(page: Page, app: Pick<BrowserTarget, "target" | "mockPort">, fixture: ReturnType<typeof fixtureFor>) {
  const target = app.target
  await page.addInitScript(({ target, directory, project, sessions, claxedoState, serverUrl }) => {
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
        __CLAXEDO_E2E_SERVER_URL__?: string
      }
      win.__CLAXEDO_TEST_AUTH_TOKEN__ = "perf-browser-token"
      win.__CLAXEDO_TEST_AUTH_USER__ = { id: "perf-browser-user" }
      win.__CLAXEDO_E2E_SERVER_URL__ = serverUrl
    }
    sessionStorage.setItem("claxedo.perf.fixture", JSON.stringify({ project, sessions }))
  }, {
    target,
    directory: fixture.directory,
    project: fixture.project,
    sessions: fixture.sessions,
    claxedoState: claxedoStateSeed(fixture),
    serverUrl: `http://127.0.0.1:${app.mockPort}`,
  })
}

export function claxedoStateSeed(
  fixture: Pick<ReturnType<typeof fixtureFor>, "directory" | "scenario" | "terminals">,
) {
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
  const initialTerminalId = fixture.scenario === "live-terminal-switch" ? contentIds[0] : undefined
  return {
    workbench: {
      panes: initialTerminalId ? [{ id: "pane_perf_terminal", contentId: initialTerminalId }] : [],
      split: initialTerminalId
        ? { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_perf_terminal" } }
        : { direction: "h", sizes: [] },
      contentIds,
      contentRecency: [...contentIds].reverse(),
      focusedPaneId: initialTerminalId ? "pane_perf_terminal" : null,
      layoutSnapshots: {},
    },
    meta: metas,
    rail: { collapsed: false, hovered: false, pinned: true, locked: false },
    workspace: {
      paneWorktree: initialTerminalId
        ? { pane_perf_terminal: { default: fixture.directory, pinned: null } }
        : {},
      recency: {},
      worktreeColor: {},
    },
    workspacePanel: {
      open: false,
      mode: "review",
      workspaceDir: fixture.directory,
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

// Sentinel for paths responseFor does not recognize. Unmatched paths answer
// 404 (loudly — they land in monitor.failedResponses + unmatchedMockPaths)
// instead of a silent 200 `{}`, so mock drift fails visibly instead of
// blanking the app with well-formed nonsense.
const UNMATCHED_MOCK_PATH = Symbol("perf.unmatched-mock-path")
const warnedUnmatchedPaths = new Set<string>()

// Request-timeline lane: CLAXEDO_PERF_REQUEST_LOG=<path> appends one JSONL row
// per mocked API request (wall-clock ms, method, path+query, status) plus a
// `boot` marker per page, so serial waterfalls / duplicate fetches / 404
// storms can be diffed across runs. Off (and zero-cost) unless the env is set.
const requestLogPath = process.env.CLAXEDO_PERF_REQUEST_LOG
let requestLogBootSeq = 0
function logMockRequest(row: Record<string, unknown>) {
  if (!requestLogPath) return
  appendFileSync(requestLogPath, `${JSON.stringify(row)}\n`)
}

// Long-poll SSE, mirroring e2e/helpers/mock-runtime.ts's drain pattern
// (route.fulfill cannot stream, so a "live" stream is a request HELD open for
// an idle window, then closed with a benign frame; the app reconnects with
// backoff). The first connection per stream path answers immediately so boot
// never waits on the hold; reconnects hold for the idle window, keeping the
// stream calm for the whole measured flow instead of hot-looping on an
// instantly-closed JSON body. The heartbeat frame carries no `id:` line on
// purpose — replay-style frames must not advance Last-Event-ID cursors.
//
// The hold is deliberately LONGER than any measured interaction window (the
// e2e mock drains at 4s; here a 4s cadence let a reconnect resolve inside
// measured windows every few seconds, feeding random microtask work into the
// frame-pair gates' tails). 25s keeps every reconnect resolution outside the
// measurement while staying under claxedo-events' 45s heartbeat watchdog;
// the global SDK's 15s pending-fetch watchdog aborts its held reconnects
// early, which its loop treats as a silent, backoff-growing retry by design.
const SSE_IDLE_HOLD_MS = 25_000
const SSE_HEARTBEAT_BODY = `data: ${JSON.stringify({ type: "heartbeat" })}\n\n`

function sseStreamPath(pathName: string) {
  if (pathName === "/event" || pathName === "/global/event") return true
  return pathName.endsWith("/api/wr/events") || pathName.endsWith("/api/wr/runtime-events")
}

export async function installMockApi(
  page: Page,
  app: BrowserTarget,
  fixture: ReturnType<typeof fixtureFor>,
  monitor: ReturnType<typeof monitorPage>,
  profile: EnvironmentProfile,
) {
  const sseConnects = new Map<string, number>()
  const bootSeq = ++requestLogBootSeq
  const bootStarted = Date.now()
  logMockRequest({ boot: bootSeq, at: bootStarted })
  // CLAXEDO_PERF_FETCH_STACKS=1 (needs CLAXEDO_PERF_REQUEST_LOG too): wrap
  // window.fetch in the page and append the JS initiator stack of each API
  // request to the request log, so duplicate fetches can be attributed to
  // their call sites (minified frames still identify distinct callers).
  if (requestLogPath && process.env.CLAXEDO_PERF_FETCH_STACKS === "1") {
    page.on("console", (message) => {
      if (!message.text().startsWith("[FETCH_STACK]")) return
      logMockRequest({ boot: bootSeq, t: Date.now() - bootStarted, stack: message.text().slice("[FETCH_STACK]".length) })
    })
    await page.addInitScript(() => {
      const original = globalThis.fetch
      const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        try {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (/workspace\/resolve|\/provider|\/api\/claxedo\/session|\/vcs|permission-mode|\/meta(?:\?|$)|\/session\/[^/]+\/config/.test(url)) {
            console.debug(`[FETCH_STACK]${url} :: ${new Error("stack").stack?.split("\n").slice(2, 8).join(" | ")}`)
          }
        } catch {}
        return original.call(this, input, init)
      }
      globalThis.fetch = wrapped as typeof globalThis.fetch
    })
  }
  await page.routeWebSocket(/\/api\/wr\/pty\/[^/]+\/connect(?:\?|$)/, (socket) => {
    socket.send("perf terminal ready\r\n")
  })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const logRow = (status: number, note?: string) => logMockRequest({
      boot: bootSeq,
      t: Date.now() - bootStarted,
      method: route.request().method(),
      path: `${url.pathname}${url.search}`,
      status,
      ...(note ? { note } : {}),
    })
    if (
      process.env.PERF_DEBUG_ERRORS &&
      (url.pathname.includes("session") || url.pathname.includes("workspace"))
    ) {
      console.error(`[PERF_ROUTE] ${route.request().method()} ${url.toString()} mock=${String(shouldMock(url, app))}`)
    }
    if (!shouldMock(url, app)) return route.fallback()
    // Stability accounting for session-switch gates (CORS preflights are
    // transport, not app requests, and stay uncounted).
    if (route.request().method() !== "OPTIONS") {
      const stability = stabilityRequestClass(url.pathname)
      if (stability) fixture.requestCounts.stability[stability] += 1
    }
    // CDP network emulation cannot slow a route we fulfil in-process, so the
    // profile's round trip is added here instead. Without it a "throttled" run
    // still answers every API call in microseconds, which would make the
    // data-dependent flows look faster under emulation than the asset-bound
    // ones — the opposite of the truth. SSE streams are exempt: they are held
    // open deliberately, and delaying the open would just shift the stream
    // start, not model latency on its events.
    if (profile.mockLatencyMs > 0 && !sseStreamPath(url.pathname)) {
      await Bun.sleep(profile.mockLatencyMs)
    }
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: mockCorsHeaders(route),
      })
    }
    if (sseStreamPath(url.pathname)) {
      // Several consumers share `/api/wr/events` (the claxedo-events central
      // stream plus both `/event`/`/global/event` rewrites in the global SDK),
      // so the first few connects answer immediately — boot never waits on the
      // hold — and only genuine RE-connects are held for the idle window.
      const connects = (sseConnects.get(url.pathname) ?? 0) + 1
      sseConnects.set(url.pathname, connects)
      logRow(200, `sse connect#${connects}`)
      if (connects > Number(process.env.CLAXEDO_PERF_SSE_FREE_CONNECTS ?? "3")) await Bun.sleep(SSE_IDLE_HOLD_MS)
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: mockCorsHeaders(route),
        body: SSE_HEARTBEAT_BODY,
      }).catch(() => undefined)
    }
    let body: unknown
    try {
      body = responseFor(url, fixture, route.request().method())
    } catch (error) {
      // A producer-status rejection is part of the contract the mock serves
      // (a client that combines `view` with `limit` must see the 400 the
      // product servers send), so it is answered, not thrown through the route.
      if (!(error instanceof MockMessagePageError)) throw error
      logRow(error.status, error.message)
      return route.fulfill({
        status: error.status,
        contentType: "application/json",
        headers: mockCorsHeaders(route),
        body: JSON.stringify({ error: error.message }),
      })
    }
    if (body === undefined) {
      logRow(0, "fallback")
      return route.fallback()
    }
    if (body === UNMATCHED_MOCK_PATH) {
      logRow(404, "unmatched")
      const key = `${route.request().method()} ${url.pathname}`
      if (!monitor.unmatchedMockPaths.includes(key)) monitor.unmatchedMockPaths.push(key)
      if (process.env.PERF_DEBUG_ERRORS || !warnedUnmatchedPaths.has(key)) {
        warnedUnmatchedPaths.add(key)
        console.warn(`[perf-mock] unmatched API path: ${key}`)
      }
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        headers: mockCorsHeaders(route),
        body: JSON.stringify({ error: "perf-harness mock: unmatched path", path: url.pathname }),
      })
    }
    logRow(200)
    const envelope = body instanceof MockJsonResponse ? body : undefined
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { ...mockCorsHeaders(route), ...(envelope?.headers ?? {}) },
      body: JSON.stringify(envelope ? envelope.body : body),
    })
  })
}

/**
 * A mock response that carries headers as well as a body. Routes return plain
 * JSON values by default; this is for the ones whose contract is partly IN the
 * response headers (the transcript page's `X-Next-Cursor`).
 */
class MockJsonResponse {
  constructor(
    readonly body: unknown,
    readonly headers: Record<string, string>,
  ) {}
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
  if (url.origin === app.baseUrl && (apiPath(url.pathname) || sseStreamPath(url.pathname))) return true
  if (
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    url.origin !== app.baseUrl &&
    (apiPath(url.pathname) || sseStreamPath(url.pathname))
  ) return true
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

function responseFor(url: URL, fixture: ReturnType<typeof fixtureFor>, method = "GET"): unknown {
  const pathName = url.pathname
  if (pathName === "/health") return { ok: true, healthy: true, version: "perf-browser" }
  if (pathName === "/global/health") return { healthy: true, version: "perf-browser" }
  if (pathName === "/experimental/session") return experimentalSessions(url, fixture)
  if (pathName === "/api/control/session-list") return sessionNavigationPage(url, fixture)
  // Loopback rewrite of the SAME navigation contract: on a loopback server
  // `sessionNavigationListUrl` (workspace-control-routes.ts:145-153) rewrites
  // `/api/control/session-list` to `/api/claxedo/session-list`, served by the
  // desktop-local product (claxedo-local-server meta-routes.ts:153) from the
  // shared `buildSessionListResponse` producer — one fixture builder for both.
  if (pathName === "/api/claxedo/session-list") return sessionNavigationPage(url, fixture)
  if (pathName === "/api/workspace") return { workspaces: controlWorkspaces(fixture) }
  if (pathName === "/api/workspace/resolve") return resolvedWorkspace(url, fixture)
  // Loopback rewrite of workspace resolve (`workspaceResolveUrl`,
  // workspace-control-routes.ts:39-42) — identical response shape.
  if (pathName === "/api/claxedo/workspace/resolve") return resolvedWorkspace(url, fixture)
  if (pathName === "/api/control/sessions") return { sessions: controlSessions(fixture, url.searchParams.get("workspaceId")) }
  // The desktop-local flat session inventory (claxedo-local-server
  // meta-routes.ts:140-152, `GET /api/claxedo/session` → `{ sessions:
  // SessionMeta[] }`), read by `fetchLocalControlSessions`
  // (features/session/data/sync/inventory-source.ts:527-535) on loopback
  // transport and mapped through `controlMetaToGlobalSession`.
  if (pathName === "/api/claxedo/session") {
    return { sessions: localSessionMetas(fixture, url.searchParams.get("directory")) }
  }
  // Usage outbox sync (features/usage/data/usage-api.ts `syncUsageOutbox`),
  // fired on boot by `installUsageOutboxWakeups`. Contract: the four counters.
  if (pathName === "/api/claxedo/usage/sync") {
    return { attempted: 0, delivered: 0, conflicts: 0, pending: 0 }
  }
  // Saved ACP connection registry (config-driven harness picker).
  if (pathName === "/api/claxedo/agent-config/harness/acp-connections") return { connections: [] }
  // Subagent hydration (directory-scope.tsx ensureSubagents) — HostSubagentRow[].
  if (/^\/session\/[^/]+\/subagents$/.test(pathName)) return []
  if (pathName === "/api/claxedo/diff/vcs" || pathName === "/api/wr/diff/vcs") {
    return changedFilesForVcs(url, fixture)
  }
  if (pathName === "/api/claxedo/diff/vcs/file" || pathName === "/api/wr/diff/vcs/file") {
    return diffForFile(url, fixture)
  }
  if (pathName === "/api/claxedo/diff/refs" || pathName === "/api/wr/diff/refs") {
    return {
      branches: ["dev"],
      tags: [],
      recent: [{ hash: "perf001", subject: "perf fixture" }],
    }
  }
  if (pathName === "/api/claxedo/diff/targets" || pathName === "/api/wr/diff/targets") {
    return { defaultRef: "dev", candidates: ["dev", "HEAD~1"] }
  }
  if (pathName === "/api/claxedo/hook/terminal-session") return terminalSessionPreview(url, fixture)
  if (pathName === "/api/wr/hook/terminal-session") return terminalSessionPreview(url, fixture)
  if (pathName === "/api/claxedo/pty") return fixture.terminals[0]
  if (pathName.startsWith("/api/claxedo/pty/")) return fixture.terminals[0] ?? {}
  if (pathName === "/api/claxedo/health") return { ok: true, healthy: true, version: "perf-browser" }
  if (pathName === "/api/claxedo/bootstrap") return boot(fixture)
  if (pathName === "/api/claxedo/agent-config/agents") return agents()
  if (pathName === "/api/claxedo/agent-config/commands") return commands()
  // Harness status + options (the composer's harness/model controls poll
  // these on every mount). CONTRACT: the real switch POST answers `{ ok: true }`
  // and nothing else; the GET reports the active harness (mock-runtime.ts
  // serves the same pair, validated against the claxedo-server handler).
  if (pathName === "/api/claxedo/agent-config/harness") {
    return method === "POST" ? { ok: true } : { type: "opencode", ok: true }
  }
  if (pathName === "/api/claxedo/agent-config/harness/options") return harnessOptions(fixture)
  // The per-harness permission-mode report, fetched on every composer mount
  // (directory-scoped draft form and the per-session form). Serving anything
  // that is not a well-formed report here blanks the WHOLE app: the readers
  // in features/session/permission/modes.ts run inside a Solid memo during
  // the composer's render, and `claxedoPermissionModes` still dereferences
  // `report?.modes.length` unguarded (modes.ts:284) — a 200 `{}` throws
  // straight into the app-level ErrorBoundary. That was this harness's
  // root failure; the shape below is the opencode row from the e2e mock's
  // MODES_BY_HARNESS table.
  if (pathName === "/permission/modes") return permissionModeReport()
  if (/^\/session\/[^/]+\/permission-mode$/.test(pathName)) return permissionModeReport()
  // Session meta for the workbench route bridge (route-bridge-resolution.ts)
  // — resolves a bare `/s/:id` route to its owning directory.
  const sessionMeta = pathName.match(/^\/api\/claxedo\/session\/([^/]+)\/meta$/)
  if (sessionMeta) {
    const session = fixture.sessions.find((item) => item.id === sessionMeta[1])
    if (!session) return UNMATCHED_MOCK_PATH
    return { directory: session.directory, title: session.title }
  }
  // Managed process inventory (features/processes/data/client.ts `list`,
  // zod-parsed as ProcessListResponse — both arrays are required).
  if (pathName === "/api/wr/process") return { configs: [], processes: [] }
  // Lifecycle checkpoints (workspace-panel). Empty is the steady state for a
  // fresh workspace; the e2e mock serves the same shape.
  if (/^\/api\/workspace\/[^/]+\/checkpoints$/.test(pathName)) return { worktrees: [] }
  // PTY metadata updates (title/size) — echo the addressed terminal.
  const wrPty = pathName.match(/^\/api\/wr\/pty(?:\/([^/]+))?$/)
  if (wrPty) {
    if (!wrPty[1]) return fixture.terminals[0]
    const terminal = fixture.terminals.find((item) => item.id === wrPty[1])
    return terminal ?? UNMATCHED_MOCK_PATH
  }
  if (pathName === "/provider") return fixture.provider
  if (pathName === "/provider/auth") return {}
  if (pathName === "/path") return fixture.path
  if (pathName === "/project") return fixture.projects
  if (pathName === "/project/current") return fixture.project
  // Project row updates (SDK `project.update`, e.g. expansion/recency touches)
  // — echo the fixture's project row, the SDK's declared response shape.
  const project = pathName.match(/^\/project\/([^/]+)$/)
  if (project) {
    if (project[1] !== fixture.project.id) return UNMATCHED_MOCK_PATH
    return fixture.project
  }
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
  if (/^\/session\/[^/]+\/subagents$/.test(pathName)) return []
  if (/^\/session\/[^/]+\/capabilities$/.test(pathName)) return capabilities()

  const messages = pathName.match(/^\/session\/([^/]+)\/message$/)
  if (messages) {
    fixture.requestCounts.messages += 1
    fixture.requestCounts.messagesBySession[messages[1]!] = (fixture.requestCounts.messagesBySession[messages[1]!] ?? 0) + 1
    return sessionMessagePage(messages[1]!, url, fixture)
  }

  return UNMATCHED_MOCK_PATH
}

function sessionNavigationPage(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const scope = url.searchParams.get("scope") === "workspace"
    ? "workspace"
    : url.searchParams.get("scope") === "global"
      ? "global"
      : "project"
  const directory = url.searchParams.get("directory")
  const sessions = directory ? sessionsForDirectory(fixture, directory) : fixture.sessions
  const items = sessions.map((session) => {
    return {
      type: "session",
      sessionRef: `local:${session.directory}:session:${session.id}`,
      sessionId: session.id,
      title: session.title,
      directory: session.directory,
      projectId: session.projectID,
      createdAt: session.time.created,
      updatedAt: session.time.updated,
      tags: [],
      attachments: [],
    }
  })
  return {
    view: {
      scope,
      groupBy: "none",
      sort: "updated_desc",
      limit: Number(url.searchParams.get("limit") ?? items.length),
    },
    items,
    totalKnown: items.length,
  }
}

function resolvedWorkspace(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const requestedDirectory = url.searchParams.get("directory")
  const requestedId = url.searchParams.get("workspaceId")
  const indexFromId = requestedId?.match(/^workspace_(\d+)$/)?.[1]
  const index = requestedDirectory
    ? Math.max(0, fixture.workspaceDirectories.indexOf(requestedDirectory))
    : indexFromId
      ? Number(indexFromId)
      : 0
  return {
    workspaceId: `workspace_${String(index)}`,
    directory: fixture.workspaceDirectories[index] ?? fixture.directory,
    kind: "local",
    status: "ready",
  }
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

export function fileContent(url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const file = url.searchParams.get("path") ?? fixture.changedFiles[0]?.file ?? "src/generated/file-0.ts"
  const heavyWorkspace =
    fixture.scenario === "heavy-workspace-reopen" ||
    fixture.scenario === "heavy-workspace-review-resume" ||
    fixture.scenario === "heavy-workspace-close"
  if (heavyWorkspace && HEAVY_WORKSPACE_REOPEN_FILE_PATHS.some((path) => path === file)) {
    return { type: "text", content: generatedFileContent(file, HEAVY_WORKSPACE_FILE_LINES) }
  }
  if (fixture.scenario === "workspace-interactions") {
    if (file === WORKSPACE_INTERACTIONS_LARGE_FILE_PATH) {
      return { type: "text", content: generatedFileContent(file, WORKSPACE_INTERACTIONS_LARGE_FILE_LINES) }
    }
    const substantial = [...WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS, WORKSPACE_INTERACTIONS_OPEN_FILE_PATH]
    if (substantial.some((path) => path === file)) {
      return { type: "text", content: generatedFileContent(file, WORKSPACE_INTERACTIONS_FILE_LINES) }
    }
  }
  if (fixture.scenario === "session-switch-workspace" && file === SESSION_SWITCH_SUBSTANTIAL_FILE_PATH) {
    return { type: "text", content: generatedFileContent(file, HEAVY_WORKSPACE_FILE_LINES) }
  }
  return { type: "text", content: `export const perfFile = ${JSON.stringify(file)}\n` }
}

function generatedFileContent(file: string, lines: number) {
  const content = Array.from(
    { length: lines },
    (_, index) => `export const perfValue${index} = ${JSON.stringify(`${file}:${index}`)}`,
  ).join("\n")
  return `${content}\n`
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

// SessionMeta rows for the desktop-local `GET /api/claxedo/session` inventory
// (claxedo-server-core session/meta/types.ts `SessionMeta`): camelCase times,
// `sessionID`, and required `tags`/`attachments`, filtered by `?directory=`
// exactly like the real handler's `listSessionMetas({ directory })`.
function localSessionMetas(fixture: ReturnType<typeof fixtureFor>, directory?: string | null) {
  return sessionsForDirectory(fixture, directory).map((session) => ({
    sessionRef: `local:${session.directory}:session:${session.id}`,
    sessionID: session.id,
    host: "central",
    title: session.title,
    directory: session.directory,
    projectID: session.projectID,
    createdAt: session.time.created,
    updatedAt: session.time.updated,
    tags: [],
    attachments: [],
  }))
}

function controlSessions(fixture: ReturnType<typeof fixtureFor>, workspaceId?: string | null) {
  const index = workspaceId ? Number(workspaceId.replace(/^workspace_/, "")) : NaN
  const directory = Number.isFinite(index) ? fixture.workspaceDirectories[index] : undefined
  return controlSessionRows(fixture, directory)
}

function controlSessionRows(fixture: ReturnType<typeof fixtureFor>, directory?: string | null) {
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

export function fixtureFor(scenario: ScenarioId, seed: SeedManifest) {
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
    // session-switch-workspace needs sessions distributed across two distinct
    // workspace directories, exactly like the workspace-switch flow.
    directory: scenario === "workspace-switch" || scenario === "session-switch-workspace"
      ? workspaceDirectories[index % workspaceDirectories.length]!
      : directory,
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
    scenario,
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
    changedFiles: Array.from({ length: Math.max(1, seed.changed_files) }, (_, index) => {
      const heavyExpandedDiff =
        index === 0 && (
          scenario === "heavy-workspace-reopen" ||
          scenario === "heavy-workspace-review-resume" ||
          scenario === "heavy-workspace-close"
        )
      // The isolated-interaction families size their diffs from the contract:
      // a substantial expand target at index 0 and a much-larger-than-median
      // diff at the large index (workspace-lifecycle keeps only the expand
      // target so its above-fold content carries real weight).
      const isolatedFamily =
        scenario === "workspace-lifecycle" ||
        scenario === "workspace-interactions" ||
        scenario === "session-switch-workspace"
      const substantialLines = heavyExpandedDiff
        ? HEAVY_WORKSPACE_EXPANDED_DIFF_LINES
        : isolatedFamily && index === WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX
          ? WORKSPACE_INTERACTIONS_EXPAND_DIFF_LINES
          : isolatedFamily && scenario !== "workspace-lifecycle" && index === WORKSPACE_INTERACTIONS_LARGE_DIFF_INDEX
            ? WORKSPACE_INTERACTIONS_LARGE_DIFF_LINES
            : undefined
      return {
        file: `src/generated/file-${index}.ts`,
        status: substantialLines !== undefined ? "modified" : index % 11 === 0 ? "added" : "modified",
        additions: substantialLines ?? (index % 9) + 1,
        deletions: substantialLines ?? index % 3,
        patch: substantialLines !== undefined
          ? heavyWorkspaceExpandedPatch(substantialLines)
          : `@@ -1 +1 @@\n-export const value = ${index}\n+export const value = ${index + 1}`,
      }
    }),
    terminals: Array.from({ length: Math.max(1, seed.terminals || 1) }, (_, index) => ({
      id: `pty_perf_${scenario.replace(/-/g, "_")}_${index}`,
      title: `Terminal ${index + 1}`,
    })),
    totalMessages: seed.messages,
    sessionRenderer: sessionRenderer(scenario),
    requestCounts: {
      messages: 0,
      messagesBySession: {} as Record<string, number>,
      expectedTranscripts: {} as Record<string, string>,
      visibleTranscripts: {} as Record<string, boolean>,
      // Mock-authoritative counters for the session-switch stability gates:
      // the route handler (the producer of every response) classifies each
      // request, so a workspace/VCS refetch cannot hide from an in-page
      // observer window.
      stability: { vcs: 0, file: 0, workspace: 0, sse: 0 } as StabilityRequestCounts,
    },
    visualFailures: [] as string[],
  }
}

function heavyWorkspaceExpandedPatch(lines: number) {
  const before = Array.from({ length: lines }, (_, index) => `-export const oldValue${index} = ${index}`)
  const after = Array.from({ length: lines }, (_, index) => `+export const newValue${index} = ${index + 1}`)
  return [`@@ -1,${lines} +1,${lines} @@`, ...before, ...after].join("\n")
}

/**
 * `GET /session/:id/message`, answered under the product's page contract
 * (see mock-message-page.ts): `view=latest-surface` is a bounded first-paint
 * fragment plus the cursor that restores what it omitted, `view=latest-turn`
 * is the complete latest turn, and `limit`/`before` walk older history.
 */
function sessionMessagePage(sessionID: string, url: URL, fixture: ReturnType<typeof fixtureFor>) {
  const selection = selectMockMessagePage({
    request: parseMockMessagePageRequest(url.searchParams),
    total: fixture.totalMessages,
    messageID: perfMessageID,
    indexOfMessageID: perfMessageIndex,
    role: perfMessageRole,
  })
  const sessionTitle = fixture.sessions.find((session) => session.id === sessionID)?.title
  const rows = selection.indexes.map((index) =>
    message(sessionID, index, fixture.directory, sessionTitle, fixture.sessionRenderer)
  )
  const items = selection.surface ? projectMockSurfacePage(rows) : rows
  if (!selection.cursor) return items
  return new MockJsonResponse(items, { "x-next-cursor": selection.cursor })
}

// The synthetic transcript's identity convention, in one place: the page
// selector needs to map a cursor back to an index, and `message()` needs to
// stamp the same ids and roles the selector reasoned about.
const PERF_MESSAGE_ID_PREFIX = "msg_perf_"

function perfMessageID(index: number) {
  return `${PERF_MESSAGE_ID_PREFIX}${index}`
}

function perfMessageIndex(id: string) {
  if (!id.startsWith(PERF_MESSAGE_ID_PREFIX)) return undefined
  const value = Number(id.slice(PERF_MESSAGE_ID_PREFIX.length))
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

function perfMessageRole(index: number): "user" | "assistant" {
  return index % 2 === 0 ? "user" : "assistant"
}

function message(
  sessionID: string,
  index: number,
  directory: string,
  sessionTitle: string | undefined,
  renderer: ReturnType<typeof sessionRenderer>,
) {
  const id = perfMessageID(index)
  const role = perfMessageRole(index)
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
            parentID: perfMessageID(Math.max(0, index - 1)),
            path: { cwd: directory, root: directory },
            modelID: model.modelID,
            providerID: model.providerID,
            mode: "build",
            cost: Number((0.0025 + index * 0.0001).toFixed(4)),
            tokens,
          }),
    },
    parts: messageParts({ sessionID, messageID: id, index, role, sessionTitle, renderer }),
  }
}

function messageParts(input: {
  sessionID: string
  messageID: string
  index: number
  role: "user" | "assistant"
  sessionTitle?: string
  renderer: ReturnType<typeof sessionRenderer>
}) {
  const rich = input.role === "assistant" && input.index % 8 === 7
  const text = {
    id: `part_perf_${input.index}`,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "text" as const,
    text: rich ? rendererText(input.renderer, input.index, input.sessionTitle ?? input.sessionID) :
      `${input.role} message ${input.index}${input.sessionTitle ? ` for ${input.sessionTitle}` : ""}\n\n${"sample output ".repeat(40 + (input.index % 20))}`,
  }
  if (input.renderer !== "diff" || !rich) return [text]

  const before = Array.from({ length: 240 }, (_, line) => `export const value${line} = ${line}`).join("\n")
  const after = Array.from({ length: 240 }, (_, line) => `export const value${line} = ${line + 1}`).join("\n")
  return [
    {
      id: `part_perf_tool_${input.index}`,
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "tool" as const,
      callID: `call_perf_tool_${input.index}`,
      tool: "edit",
      state: {
        status: "completed" as const,
        input: {
          filePath: `src/generated/session-${input.index}.ts`,
          oldString: before,
          newString: after,
        },
        output: "File edited successfully",
        title: `Edit src/generated/session-${input.index}.ts`,
        metadata: {
          filediff: {
            file: `src/generated/session-${input.index}.ts`,
            before,
            after,
            additions: 240,
            deletions: 240,
          },
        },
        time: { start: 1_700_000_000_000 + input.index * 1000, end: 1_700_000_000_500 + input.index * 1000 },
      },
    },
    text,
  ]
}

function sessionRenderer(scenario: ScenarioId): SessionRenderer {
  if (scenario !== "session-switch") return "plain"
  const value = process.env.CLAXEDO_PERF_SESSION_RENDERER
  if (value === "plain" || value === "markdown" || value === "code" || value === "mermaid" || value === "diff") {
    return value
  }
  return "diff"
}

function rendererText(renderer: ReturnType<typeof sessionRenderer>, index: number, sessionLabel: string) {
  if (renderer === "markdown") {
    return [
      `# Renderer profile ${sessionLabel} ${index}`,
      "",
      "This fixture exercises **strong text**, _emphasis_, `inline code`, and [a link](https://example.com).",
      "",
      ...Array.from(
        { length: 40 },
        (_, row) => `- ${sessionLabel} item ${row}: ${"rendered markdown content ".repeat(4)}`,
      ),
      "",
      "| Name | State | Detail |",
      "| --- | --- | --- |",
      ...Array.from(
        { length: 40 },
        (_, row) => `| ${sessionLabel}-row-${row} | ready | ${"table value ".repeat(4)} |`,
      ),
    ].join("\n")
  }
  if (renderer === "code") {
    return [
      "```typescript",
      `export const session = ${JSON.stringify(sessionLabel)}`,
      ...Array.from({ length: 240 }, (_, row) => `export const value${row} = (input: number) => input + ${row}`),
      "```",
    ].join("\n")
  }
  if (renderer === "mermaid") {
    return [
      "```mermaid",
      "flowchart LR",
      `  session[${sessionLabel.replace(/[^a-zA-Z0-9 ]/g, " ")}] --> node0[Step 0]`,
      ...Array.from({ length: 60 }, (_, row) => `  node${row}[Step ${row}] --> node${row + 1}[Step ${row + 1}]`),
      "```",
    ].join("\n")
  }
  return `assistant message ${index}\n\n${"sample output ".repeat(60)}`
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

// The opencode harness's permission-mode report (HarnessModeReport,
// src/features/session/permission/modes.ts:403). opencode enforces no modes
// of its own, so the contract answer is an EMPTY modes list plus the
// `unsupported` reason — the same row the e2e mock's MODES_BY_HARNESS table
// records for opencode. `modes` must always be an array: readers dereference
// `report?.modes.length` during the composer's render, and a 200 body without
// it throws into the app-level ErrorBoundary.
function permissionModeReport() {
  return {
    modes: [],
    unsupported: "opencode has no permission modes of its own",
    appliesFrom: "next-turn",
  }
}

// Harness options for the composer's model control (same shape the e2e mock
// serves): one `model` select whose current value matches the fixture's
// provider/model pair so the composer never renders a missing-model state.
function harnessOptions(fixture: ReturnType<typeof fixtureFor>) {
  const provider = fixture.provider.all[0]!
  const model = Object.values(provider.models)[0]!
  return {
    source: "runner",
    stale: false,
    options: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: model.id,
        selectOptions: [{ id: model.id, name: model.name }],
      },
    ],
  }
}

export function sessionPath(fixture: { directory: string }, sessionId: string) {
  return `/s/${sessionId}`
}

export function workspacePath(directory: string) {
  return `/${base64Encode(directory)}`
}

function base64Encode(value: string) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export async function startApp(): Promise<BrowserTarget> {
  const basePort = await freePort()
  const mockPort = Number(process.env.CLAXEDO_PERF_MOCK_PORT) || await freePort()
  const baseUrl = `http://127.0.0.1:${basePort}`
  const script = process.env.CLAXEDO_PERF_APP_SCRIPT ?? "serve"
  if (script === "serve" && process.env.CLAXEDO_PERF_SKIP_BUILD !== "1") await buildProductionApp(mockPort)
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
      VITE_CLAXEDO_E2E: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  void drain(proc.stdout)
  void drain(proc.stderr)
  await waitForServer(baseUrl, proc)
  return { target: app.id, baseUrl, mockPort, command, process: proc }
}

async function buildProductionApp(mockPort: number) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "build"],
    cwd: appRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_SERVER_HOST: "127.0.0.1",
      PLAYWRIGHT_SERVER_PORT: String(mockPort),
      VITE_OPENCODE_SERVER_HOST: "127.0.0.1",
      VITE_OPENCODE_SERVER_PORT: String(mockPort),
      VITE_OPENCODE_BACKEND_URL: `http://127.0.0.1:${mockPort}`,
      VITE_CLAXEDO_SERVER_URL: `http://127.0.0.1:${mockPort}`,
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await proc.exited === 0) return
  throw new Error("Claxedo production build failed before performance measurement")
}

export async function stopApp(app: BrowserTarget) {
  if (!app.process) return
  app.process.kill()
  const exited = await Promise.race([
    app.process.exited.then(() => true).catch(() => true),
    Bun.sleep(10_000).then(() => false),
  ])
  if (exited) return
  app.process.kill("SIGKILL")
  await Promise.race([
    app.process.exited.catch(() => undefined),
    Bun.sleep(2_000),
  ])
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
  // Gating runs retain the lightweight isolated context until suite teardown.
  // Closing only the page releases its renderer without a late context-close
  // operation racing the next half of the pair.
  if (!video) {
    await Promise.race([
      page.close().catch(() => undefined),
      Bun.sleep(2_000),
    ])
    return undefined
  }
  const closed = await Promise.race([
    context.close().then(() => true).catch(() => false),
    Bun.sleep(5_000).then(() => false),
  ])
  if (!closed) return undefined
  const raw = video ? await video.path().catch(() => undefined) : undefined
  if (!raw || !await Bun.file(raw).exists()) return undefined
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

export function monitorPage(page: Page) {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  const failedRequests: string[] = []
  const unmatchedMockPaths: string[] = []
  page.on("pageerror", (error) => {
    pageErrors.push(error.message)
  })
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.failure()?.errorText ?? "failed"} ${request.method()} ${request.url()}`)
  })
  return { pageErrors, consoleErrors, failedResponses, failedRequests, unmatchedMockPaths }
}

async function validationFailures(
  page: Page,
  monitor: ReturnType<typeof monitorPage>,
  scenario: ScenarioId,
  fixture: ReturnType<typeof fixtureFor>,
) {
  const text = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "")
  const boundaryRendered = text.includes("Something went wrong") || text.includes("An error occurred while loading the application")
  // The boundary's error text lives in a textarea's .value, which
  // body.innerText excludes — read it so the failure carries the actual error
  // instead of only "error boundary rendered".
  const boundaryError = boundaryRendered ? await readBoundaryError(page) : ""
  // The composer's model control (`[data-action='prompt-model']`, named by
  // 302c88e5f). The old literal checks ("Model unavailable" / "Select agent")
  // matched strings the app no longer renders anywhere, so they could never
  // fire; a broken model surface now shows as a control with an empty
  // accessible name (label empty while the provider list never resolves).
  const composerModel = await page.evaluate(() => {
    const control = document.querySelector<HTMLElement>("[data-action='prompt-model']")
    if (!control) return { present: false, named: false }
    const name = control.getAttribute("aria-label") ?? control.textContent ?? ""
    return { present: true, named: !!name.trim() }
  }).catch(() => ({ present: false, named: false }))
  return [
    ...monitor.pageErrors.map((error) => `page error: ${error}`),
    ...monitor.consoleErrors.filter(significantConsoleError).map((error) => `console error: ${error}`),
    ...(boundaryRendered
      ? [`error boundary rendered for ${scenario}${boundaryError ? `: ${boundaryError.replace(/\s+/g, " ").trim().slice(0, 400)}` : ""}`]
      : []),
    ...(!text.trim() ? [`blank page rendered for ${scenario}`] : []),
    ...(missingSessionMessageRequest(scenario, fixture) ? [`session messages were not requested for ${scenario}`] : []),
    ...(sessionScenario(scenario) && loadingOnly(text) ? [`session page was still loading for ${scenario}`] : []),
    ...(sessionScenario(scenario) && !boundaryRendered && composerModel.present && !composerModel.named
      ? [`composer model control had no label for ${scenario}`]
      : []),
    ...fixture.visualFailures,
    ...Object.entries(fixture.requestCounts.expectedTranscripts).flatMap(([sessionID, expected]) =>
      fixture.requestCounts.visibleTranscripts[sessionID] ? [] : [`transcript text was not visible for ${scenario}: ${expected}`],
    ),
  ].filter((failure, index, failures) => failures.indexOf(failure) === index)
}

function significantConsoleError(text: string) {
  // The harness serves the app against a route-mocked fixture with no real
  // backend on :3001; the global-sdk SSE stream cannot be route-mocked, so its
  // eventual "TypeError: Failed to fetch" is environmental here — every flow
  // would fail on it while the app is healthy. Everything else stays fatal.
  if (text.includes("[global-sdk] event stream failed") && text.includes("Failed to fetch")) return false
  return ["Cannot read properties", "ReferenceError", "TypeError", "Uncaught", "Something went wrong"].some((needle) => text.includes(needle))
}

function loadingOnly(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized === "Loading..." || normalized === "Loading" || normalized.endsWith(" Loading...")
}

function sessionScenario(_scenario: ScenarioId) {
  // Every surviving flow navigates into a specific session, so this always
  // qualifies for the "session messages were requested" check.
  return true
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

export async function waitForTranscript(page: Page, fixture: ReturnType<typeof fixtureFor>, sessionID: string, text: string) {
  fixture.requestCounts.expectedTranscripts[sessionID] = text
  const visible = await page.waitForFunction(({ id, expected }) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-testid='session-page-root']"))
      .some((node) => {
        if (node.dataset.sessionId !== id) return false
        const rect = node.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        if (node.dataset.sessionFirstFoldReady !== "true") return false
        if (node.dataset.sessionMessagesReady !== "true") return false
        const messageCount = Number(node.dataset.sessionMessageCount ?? node.dataset.sessionConversationCount ?? "0")
        if (Number.isFinite(messageCount) && messageCount <= 0) return false
        const timeline = node.querySelector<HTMLElement>("[data-session-timeline-root]")
        if (!timeline || timeline.dataset.sessionTimelineRevealReady !== "true") return false
        if (timeline.dataset.sessionTimelineProgressiveReady !== "true") return false
        if (getComputedStyle(timeline).visibility === "hidden") return false
        if (Number(timeline.dataset.sessionTimelineKeyCount ?? "0") <= 0) return false
        // "Some mounted row has rendered content" — NOT "the first row in DOM
        // order has content". `TurnGap` (message-timeline.tsx:1398) is a real
        // timeline row that is `aria-hidden` and deliberately EMPTY, and on a
        // cold mount with overscan 1 it is routinely the first row above the
        // fold. Sampling only `querySelector` therefore made readiness depend
        // on which arbitrary row happened to lead the list: with a spacer
        // leading, this clause stayed false for ~1.25 s after the transcript
        // was fully rendered and visible, and only flipped when an unrelated
        // event (the 2 s SSE reconnect advisory disappearing, growing the
        // scroller by 28 px) mounted two more rows. That pinned
        // `transcript_render_ms` to RECONNECT_DELAY_MS + first-connect ~= 2.28 s
        // and made it insensitive to transcript work — a wall-clock timer
        // wearing a render metric's name (its relative stddev was 0.002 on a
        // host where real work scatters 7-19%).
        // The content proof is unchanged and still independent: the expected
        // text assertion below has to pass either way.
        const rows = Array.from(timeline.querySelectorAll<HTMLElement>("[data-timeline-key]"))
        if (!rows.some((row) => (row.textContent ?? "").trim())) return false
        return (timeline.textContent ?? "").includes(expected)
      }),
    { id: sessionID, expected: text },
    { timeout: 10_000 },
  ).then(() => true).catch(() => false)
  if (visible) {
    fixture.requestCounts.visibleTranscripts[sessionID] = true
    return
  }
  recordVisualFailure(fixture, `seeded transcript text did not render for ${sessionID}: ${text}`)
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

async function measureInPageSessionFirstFoldSwitch(
  page: Page,
  session: ReturnType<typeof fixtureFor>["sessions"][number],
  options: {
    renderer?: ReturnType<typeof sessionRenderer>
    renderMermaid?: boolean
    beforeClick?: () => Promise<void>
    afterReady?: () => Promise<void>
  } = {},
) {
  const rowSelector = `[data-testid="rail-sidebar-session-row"][data-session-id="${session.id}"]`
  const canonicalRow = page.locator(rowSelector).first()
  const row = await canonicalRow.count()
    ? canonicalRow
    : page.locator("[role='button'], button, a").filter({ hasText: session.title }).first()
  if (!await row.count()) return 10_000
  await row.scrollIntoViewIfNeeded()
  const canonicalActivate = row.locator('[data-slot="navigation-row-activate"]').first()
  const activate = await canonicalActivate.count() ? canonicalActivate : row
  const mark = `claxedo-session-switch-${session.id}-${crypto.randomUUID()}`
  const before = await activate.evaluate((node, input) => {
    const id = input.id
    const beforeRoot = document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`)
    const beforeContent = document.querySelector<HTMLElement>(`[data-testid="session-content"][data-session-id="${CSS.escape(id)}"]`)
    performance.clearMarks(input.mark)
    node.addEventListener("pointerdown", (event) => {
      if (event.isTrusted) performance.mark(input.mark)
    }, { once: true })
    return {
      hadBeforeRoot: !!beforeRoot,
      hadBeforeContent: !!beforeContent,
      beforeReady: beforeRoot?.dataset.sessionMessagesReady,
      beforeCount: beforeRoot?.dataset.sessionMessageCount,
    }
  }, { id: session.id, mark })
  // Use Playwright's trusted mouse input so the benchmark follows the exact
  // browser pointer lifecycle. Hand-dispatched PointerEvents are untrusted and
  // do not reproduce the real activation/drag boundary this benchmark measures.
  await options.beforeClick?.()
  await activate.click({ timeout: 5_000 })
  const result = await page.evaluate(async ({ id, debug, renderer, renderMermaid, mark, before }) => {
    const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
    if (started === undefined) throw new Error(`Trusted session switch did not emit pointerdown for ${id}`)
    const traceWindow = window as unknown as {
      __claxedoPerfTrace?: boolean
      __claxedoPerfRendererPhases?: Array<{ name: string; durationMs: number }>
    }
    if (traceWindow.__claxedoPerfTrace) {
      traceWindow.__claxedoPerfRendererPhases?.push({
        name: "sessionSwitch.click",
        durationMs: performance.now() - started,
      })
    }
    const ms = await new Promise<number>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - started
        const targetRoot = document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`)
        const readyMessages = targetRoot?.dataset.sessionFirstFoldReady === "true" &&
          targetRoot.dataset.sessionMessagesReady === "true" &&
          Number(targetRoot?.dataset.sessionMessageCount ?? targetRoot?.dataset.sessionConversationCount ?? "0") > 0
        const timeline = targetRoot?.querySelector<HTMLElement>("[data-session-timeline-root]")
        const baseTimelineReady = timeline?.dataset.sessionTimelineRevealReady === "true" &&
          timeline.dataset.sessionTimelineProgressiveReady === "true" &&
          getComputedStyle(timeline).visibility !== "hidden" &&
          Number(timeline.dataset.sessionTimelineKeyCount ?? "0") > 0 &&
          // Same defect as `waitForTranscript` (fixed in 9d16de0): sampling
          // only the FIRST `[data-timeline-key]` in DOM order makes readiness
          // depend on whether a `TurnGap` — an aria-hidden, deliberately empty
          // spacer row that routinely leads a cold mount — happens to lead the
          // list. Require SOME mounted row to carry content instead.
          Array.from(timeline.querySelectorAll<HTMLElement>("[data-timeline-key]")).some(
            (row) => (row.textContent ?? "").trim(),
          )
        const inlineDiffReady = !!timeline?.querySelector(
          "[data-timeline-row-rich-ready='true'] [data-component='edit-content']",
        )
        if (baseTimelineReady && renderer === "diff" && !inlineDiffReady) {
          const trigger = timeline?.querySelector<HTMLElement>(
            "[data-component='edit-tool'] [data-slot='collapsible-trigger']",
          )
          if (trigger && trigger.getAttribute("aria-expanded") !== "true" && trigger.dataset.perfOpened !== "true") {
            trigger.dataset.perfOpened = "true"
            trigger.click()
          }
        }
        const rendererReady = renderer === "diff" ? inlineDiffReady
          : renderer === "markdown" ? !!timeline?.querySelector("[data-component='markdown'] table") &&
            !timeline?.querySelector("[data-markdown-progressive='pending']")
          : renderer === "code" ? !!timeline?.querySelector("[data-markdown-complete='true'] [data-component='markdown-code']")
          : renderer === "mermaid" && renderMermaid === false
            ? !!timeline?.querySelector("[data-mermaid-state='deferred'] [data-slot='mermaid-render-button']")
          : renderer === "mermaid" ? !!timeline?.querySelector("[data-mermaid-state='rendered'] [data-slot='mermaid-diagram'] svg")
          : true
        if (baseTimelineReady && renderer === "mermaid" && renderMermaid !== false && !rendererReady) {
          timeline?.querySelector<HTMLElement>("[data-slot='mermaid-render-button']")?.click()
        }
        const readyTimeline = baseTimelineReady && rendererReady
        if (targetRoot && !targetRoot.closest("[aria-hidden='true']") && readyMessages && readyTimeline) {
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
    const afterTimeline = afterRoot?.querySelector<HTMLElement>("[data-session-timeline-root]")
    const output = {
      ms,
      debug: debug
        ? {
            ...before,
            afterReady: afterRoot?.dataset.sessionMessagesReady,
            afterCount: afterRoot?.dataset.sessionMessageCount,
            timelineRows: afterTimeline?.dataset.sessionTimelineRowCount,
            virtualRows: afterTimeline?.dataset.sessionTimelineKeyCount,
            progressiveReady: afterTimeline?.dataset.sessionTimelineProgressiveReady,
            mountedRows: afterTimeline?.querySelectorAll("[data-timeline-key]").length,
            rowTypes: Array.from(afterTimeline?.querySelectorAll<HTMLElement>("[data-timeline-row]") ?? [])
              .map((node) => node.dataset.timelineRow),
            messageBodies: afterTimeline?.querySelectorAll("[data-slot='session-turn-message-content']").length,
            editTools: afterTimeline?.querySelectorAll("[data-component='edit-tool']").length,
            editContents: afterTimeline?.querySelectorAll("[data-component='edit-content']").length,
            readyEditContents: afterTimeline?.querySelectorAll(
              "[data-timeline-row-rich-ready='true'] [data-component='edit-content']",
            ).length,
            markdownTables: afterTimeline?.querySelectorAll("[data-component='markdown'] table").length,
            progressiveMarkdown: Array.from(
              afterTimeline?.querySelectorAll<HTMLElement>("[data-markdown-progressive]") ?? [],
            ).map((node) => node.dataset.markdownProgressive),
            markdownRowHeights: Array.from(
              afterTimeline?.querySelectorAll<HTMLElement>("[data-markdown-progressive]") ?? [],
            ).map((node) => node.closest<HTMLElement>("[data-index]")?.offsetHeight),
            highlightedCode: afterTimeline?.querySelectorAll("[data-markdown-complete='true'] [data-component='markdown-code']").length,
            renderedMermaid: afterTimeline?.querySelectorAll("[data-mermaid-state='rendered'] [data-slot='mermaid-diagram'] svg").length,
          }
        : undefined,
    }
    performance.clearMarks(mark)
    return output
  }, {
    id: session.id,
    debug: Bun.env.CLAXEDO_PERF_DEBUG_SESSION_SWITCH === "1",
    renderer: options.renderer ?? "plain",
    renderMermaid: options.renderMermaid,
    mark,
    before,
  })
  await options.afterReady?.()
  if (result.debug) console.log("first-fold-switch-debug", JSON.stringify(result.debug))
  if (result.ms >= 10_000) {
    await page.goto(`${new URL(page.url()).origin}${sessionPath(session, session.id)}`, {
      waitUntil: "domcontentloaded",
    })
    await waitForUsefulScreen(page)
  }
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

async function navigateToTerminalRoute(
  page: Page,
  app: BrowserTarget,
  fixture: ReturnType<typeof fixtureFor>,
  terminal: ReturnType<typeof fixtureFor>["terminals"][number],
  reload: boolean,
) {
  const route = `${workspacePath(fixture.directory)}/terminal/${encodeURIComponent(terminal.id)}`
  if (reload) {
    await page.goto(`${app.baseUrl}${route}`, { waitUntil: "domcontentloaded" })
    await waitForUsefulScreen(page)
    await waitForLaunchStable(page)
  } else {
    await page.evaluate((pathName) => {
      history.pushState({}, "", pathName)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }, route)
  }
  await page.waitForFunction((id) =>
    !!document.querySelector(
      `[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${CSS.escape(id)}"], ` +
      `[data-testid="terminal-pane"][data-terminal-id="${CSS.escape(id)}"]`,
    ),
  terminal.id, { timeout: 10_000 })
  await waitForTerminalSurface(page, fixture)
}

async function openTerminalSurface(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  terminal?: ReturnType<typeof fixtureFor>["terminals"][number],
) {
  if (await clickTerminalInventoryRow(page, terminal)) {
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
  await clickTerminalInventoryRow(page, terminal)
  await waitForTerminalSurface(page, fixture)
}

async function clickTerminalInventoryRow(
  page: Page,
  terminal?: ReturnType<typeof fixtureFor>["terminals"][number],
) {
  const row = terminal
    ? page.locator(
        `[data-testid='terminal-section'] [data-testid='rail-sidebar-terminal-row'][data-terminal-id="${terminal.id}"]`,
      ).first()
    : page.locator("[data-testid='terminal-section'] [data-testid='rail-sidebar-terminal-row']").last()
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

export async function openReviewSurface(
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

async function toggleDiffStyle(page: Page, options: { settle?: "video" | "frame" } = {}) {
  const previous = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-diff-style]"))
      .find((node) => !node.closest("[aria-hidden='true']"))
      ?.dataset.reviewDiffStyle)
  if (previous !== "split" && previous !== "unified") throw new Error("Visible review diff style was not ready")
  const expected = previous === "split" ? "unified" : "split"
  const settle = async () => {
    if ((options.settle ?? "video") === "video") await settleForVideo(page)
    else await waitForAnimationFrame(page, 2)
  }
  await page.locator(
    `[data-testid="review-diff-style-toggle"][data-review-next-diff-style="${expected}"]`,
  ).last().click({ timeout: 2_000 })
  await page.waitForFunction((style) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-diff-style]"))
      .some((node) => !node.closest("[aria-hidden='true']") && node.dataset.reviewDiffStyle === style),
  expected, { timeout: 2_000 })
  await settle()
}

async function waitForReviewStable(page: Page) {
  await page.waitForFunction(() => {
    const review = document.querySelector("#review-panel [data-review-diff-style]")
    return !!review?.getAttribute("data-review-diff-style") && Number(review.getAttribute("data-review-rendered-hunks") ?? "0") > 0
  }, undefined, { timeout: 2_000 })
  await waitForAnimationFrame(page, 2)
}

async function waitForHeavyReviewCorpus(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const expected = fixture.changedFiles.length
  const cap = HEAVY_WORKSPACE_REVIEW_WINDOW_MAX_ROWS + HEAVY_WORKSPACE_REVIEW_WINDOW_SLACK
  // The file list is windowed: the MODEL must hold every changed file while
  // the DOM holds only a window's worth of rows -- and the two counters must
  // agree with the actual mounted rows.
  const complete = await page.waitForFunction(({ expected, cap }) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const root = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    if (!corpus) return false
    const rendered = Number(corpus.dataset.reviewRenderedFiles ?? "0")
    return Number(corpus.dataset.reviewTotalFiles ?? "0") === expected &&
      rendered > 0 && rendered <= cap &&
      root?.querySelectorAll("[data-review-file]").length === rendered
  }, { expected, cap }, { timeout: 12_000 }).then(() => true).catch(() => false)
  if (!complete) recordVisualFailure(fixture, `Review did not hold its ${expected}-file model behind a bounded row window`)
  await waitForAnimationFrame(page, 2)
}

async function scrollHeavyReviewWorkingSet(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const targetPath = fixture.changedFiles[Math.floor(fixture.changedFiles.length * 0.7)]?.file
  if (!targetPath) {
    recordVisualFailure(fixture, "heavy Review fixture had no deep-scroll target")
    return
  }
  const scrolled = await page.evaluate(async ({ targetPath, fileOrder, scrollSelector }) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const root = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    const scroll = root?.querySelector<HTMLElement>(scrollSelector)
    if (!scroll) return false
    const fileIndex = new Map(fileOrder.map((file, index) => [file, index]))
    const targetIndex = fileIndex.get(targetPath)
    if (targetIndex === undefined) return false
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const materialized = () => Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])
      .filter((row) => fileIndex.has(row.dataset.reviewFile ?? ""))
    const findTarget = () => materialized().find((row) => row.dataset.reviewFile === targetPath)
    // The windowed list only materializes rows near the scroll position, so a
    // deep row cannot be scrolled to directly. Hop toward it from the nearest
    // materialized row -- each hop lands within the previous height-estimate
    // error, so a few hops converge even when an expanded row above has made
    // proportional guesses land a window short -- then align exactly once the
    // row exists. The same motion as a user's scrollbar drag plus settle.
    for (let attempt = 0; attempt < 12; attempt++) {
      const target = findTarget()
      const scrollRect = scroll.getBoundingClientRect()
      if (target) {
        const targetRect = target.getBoundingClientRect()
        if (Math.abs(targetRect.top - scrollRect.top) <= 1) break
        scroll.scrollTop += targetRect.top - scrollRect.top
      } else {
        const rows = materialized()
        const nearest = rows.reduce<HTMLElement | undefined>((best, row) => {
          const index = fileIndex.get(row.dataset.reviewFile ?? "")!
          const bestIndex = best ? fileIndex.get(best.dataset.reviewFile ?? "")! : undefined
          return bestIndex === undefined || Math.abs(index - targetIndex) < Math.abs(bestIndex - targetIndex)
            ? row
            : best
        }, undefined)
        if (nearest) {
          const nearestIndex = fileIndex.get(nearest.dataset.reviewFile ?? "")!
          const rowHeight = nearest.offsetHeight || 40
          const nearestRect = nearest.getBoundingClientRect()
          scroll.scrollTop += (nearestRect.top - scrollRect.top) + (targetIndex - nearestIndex) * rowHeight
        } else {
          scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) *
            (targetIndex / Math.max(1, fileOrder.length - 1))
        }
      }
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }))
      await frame()
      await frame()
    }
    return scroll.scrollTop > 0 && !!findTarget()
  }, {
    targetPath,
    fileOrder: fixture.changedFiles.map((file) => file.file),
    scrollSelector: HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR,
  })
  if (!scrolled) recordVisualFailure(fixture, `Review did not scroll to substantial content at ${targetPath}`)
  await waitForAnimationFrame(page, 3)
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
