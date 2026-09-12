import { asRecord, asRecordOrEmpty } from "@claxedo/helpers/guards"
import { runAttribution } from "./attribution"
import { publishBrowserResult } from "./browser-publication"
import {
  captureMeasurementProvenance,
  captureSourceProvenance,
  measurementProvenanceEvidence,
  type MeasurementProvenanceEvidence,
} from "./measurement-provenance"
import { browserContext, configureExecution } from "./execution-profile"
import { requireSupportedStack } from "./stacks"
import { mergeDiagnosticsRuns, startFlowProfiler } from "./browser/diagnostics"
import { startApp, launchBenchmarkBrowser, closeBenchmarkBrowser, stopApp, type BrowserTarget, benchmarkViewport, closeContextAndSaveVideo } from "./browser/environment"
import { fixtureFor } from "./browser/fixtures"
import { installMockApi } from "./browser/mock-api"
import { monitorPage, validationFailures, readBoundaryError, browserFailureDiagnostics } from "./browser/page-validation"
import { heavyWorkspaceReopen } from "./browser/scenarios/heavy-workspace"
import { largeDiffToggle } from "./browser/scenarios/review"
import { launchProject, sessionSwitch } from "./browser/scenarios/session"
import { sessionSwitchWorkspace } from "./browser/scenarios/session-switch-workspace"
import { transcriptFlick } from "./browser/scenarios/transcript-flick"
import { liveTerminalSwitch } from "./browser/scenarios/terminal"
import { workspaceInteractions } from "./browser/scenarios/workspace-interactions"
import { workspaceLifecycle } from "./browser/scenarios/workspace-lifecycle"
import { workspaceSwitch } from "./browser/scenarios/workspace-switch"
import { installSeedState } from "./browser/state"
import { environmentProfile, type EnvironmentProfile, applyCpuProfile, applyNetworkProfile } from "./environment-profile"
import { flowName, type FlowResult } from "./flows"
import { type FrameMetric, mergeFrameMetrics } from "./frame-sampler"
import { applyBudget, jsonReport, markdownReport } from "./report"
import { seedForScenario } from "./seed"
import { summarize } from "./stats"
import { reportsRoot, writeJson, harnessRoot } from "./storage"
import type { ScenarioResult, RunOptions, ScenarioId, DiagnosticsOverheadEvidence } from "./types"
import { installWebVitals, readWebVitals, mergeWebVitals, type WebVitals } from "./web-vitals"
import path from "node:path"
import type { Browser, Page } from "playwright-core"

export type BrowserRun = Omit<ScenarioResult, "budget" | "status" | "failures" | "warnings"> & {
  validation_failures?: string[]
}

class BrowserScenarioError extends Error {
  constructor(message: string, readonly videoPath?: string) {
    super(message)
    this.name = "BrowserScenarioError"
  }
}

export const diagnosticsPairModeOrder = [
  { label: "disabled control A", enabled: false },
  { label: "diagnostics enabled A", enabled: true },
  { label: "diagnostics enabled B", enabled: true },
  { label: "disabled control B", enabled: false },
] as const

export async function runBrowser(options: RunOptions) {
  requireSupportedStack(options.stack)
  if (!Number.isInteger(options.iterations) || options.iterations < 1) throw new Error("--iterations must be a positive integer")
  environmentProfile(options.profile)
  const instrumentation = configureExecution(options.suite)
  if (options.suite === "attribution" && options.accept_baseline) throw new Error("Attribution runs cannot accept baselines")
  const results: ScenarioResult[] = []
  const publications: Array<{ result: ScenarioResult; valid: boolean; provenance: MeasurementProvenanceEvidence }> = []
  // This snapshot precedes startApp's production build. A post-build snapshot
  // alone could certify an artifact built while its source was changing.
  const buildSource = await captureSourceProvenance()
  const builtArtifact = (process.env.CLAXEDO_PERF_APP_SCRIPT ?? "serve") === "serve"
  const target = await startApp()
  const browsers: Browser[] = []
  try {
    browsers.push(await launchBenchmarkBrowser(options))
    if (options.suite === "diagnostics") browsers.push(await launchBenchmarkBrowser(options))
    const captureProvenance = () => captureMeasurementProvenance({
      browserVersion: browsers[0].version(),
      appCommand: target.command,
      artifactMode: builtArtifact ? "built" : "source-only",
    })
    const builtProvenance = await captureProvenance()
    for (const scenario of options.scenarios) {
      try {
        const startProvenance = await captureProvenance()
        const modeRuns = options.suite === "diagnostics"
          ? [
              ...await executeBrowserScenarioPair(options, target, scenario, browsers[0], diagnosticsPairModeOrder.slice(0, 2)),
              ...await executeBrowserScenarioPair(options, target, scenario, browsers[1], diagnosticsPairModeOrder.slice(2)),
            ]
          : [{ label: options.suite, enabled: false, result: await executeBrowserScenarioMode(options, target, scenario, browsers[0], false) }]
        const controls = modeRuns.filter((item) => !item.enabled)
        const enabled = modeRuns.filter((item) => item.enabled)
        const selected = enabled.length ? enabled : controls
        const measuredRun = mergeBrowserRuns(selected.map((item) => item.result.run))
        // Keep measured repetitions in the raw report if the source/artifact
        // disappears or becomes unreadable. Missing proof prevents publication.
        const finalCapture = await captureProvenance().then(
          (end) => ({ end }),
          (error: unknown) => ({ captureError: error instanceof Error ? error.message : String(error) }),
        )
        const provenance = measurementProvenanceEvidence({
          buildSource,
          build: builtProvenance,
          start: startProvenance,
          ...finalCapture,
          artifactMode: builtArtifact ? "built" : "source-only",
        })
        const diagnostics = enabled.length ? {
          ...mergeDiagnosticsRuns(enabled.map((item) => {
            if (!item.result.diagnostics) throw new Error(`${item.label} produced no profiler evidence`)
            return item.result.diagnostics
          })),
          controlHeadline: mergeBrowserRuns(controls.map((item) => item.result.run)).headline,
          controlRepetitions: controls.flatMap((item) => item.result.run.repetitions ?? [{ headline: item.result.run.headline, vitals: item.result.run.vitals }]),
          enabledHeadline: measuredRun.headline,
        } : undefined
        const measured = {
          ...measuredRun,
          diagnostics,
          provenance,
          context: browserContext({ suite: options.suite, profile: options.profile, workload: measuredRun.seed,
            browserVersion: selected[0].result.browserVersion, instrumentation, headless: options.headless }),
          attribution: runAttribution({
            browserVersion: selected[0].result.browserVersion,
            server: { baseUrl: target.baseUrl, mockPort: target.mockPort, command: target.command },
          }),
        }
        const budgeted = applyBudget(measured, { scenario })
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
        publications.push({ result, valid: validationFailures.length === 0, provenance })
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

  // Durable evidence modifies tracked harness data. Publish only after every
  // source snapshot, so these writes cannot contaminate subsequent scenarios.
  for (const { result, valid, provenance } of publications) {
    try {
      await publishBrowserResult(result, options, valid, provenance)
    } catch (error) {
      result.status = "fail"
      result.failures.push(`Measurement publication failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    console.log(`[perf] ${result.id} (${options.suite}): ${result.status}`)
  }

  const output = path.isAbsolute(options.output) ? options.output : path.join(reportsRoot, options.output)
  await writeJson(output, jsonReport(results))
  await Bun.write(output.replace(/\.json$/, ".md"), markdownReport(results, { debug: options.debug }))
  await writeJson(path.join(reportsRoot, "latest.json"), jsonReport(results))
  await Bun.write(path.join(reportsRoot, "latest.md"), markdownReport(results, { debug: options.debug }))
  return results
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
      // The narrowing runs here, not in the browser: an evaluate body is
      // serialized, so it cannot reach a module-scope import.
      const snapshot = await page.evaluate(() => {
        const raw = localStorage.getItem("claxedo.state.v5")
        const persisted: unknown = raw ? JSON.parse(raw) : undefined
        return {
          persisted,
          terminalRows: document.querySelectorAll("[data-testid='terminal-section'] [data-testid='rail-sidebar-terminal-row']").length,
        }
      }).catch(() => undefined)
      // Persisted state is whatever the last build wrote; this debug dump
      // reports the three fields it can find and stays silent about the rest.
      const state = snapshot && (() => {
        const parsed = asRecordOrEmpty(snapshot.persisted)
        const workbench = asRecord(parsed.workbench)
        const meta = asRecordOrEmpty(parsed.meta)
        const owner = asRecordOrEmpty(asRecord(parsed.terminal)?.owner)
        return {
          contentIds: workbench?.contentIds,
          metaIds: Object.keys(meta),
          terminalIds: Object.keys(owner),
          terminalRows: snapshot.terminalRows,
        }
      })()
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

export function mergeBrowserRuns(rawRuns: BrowserRun[]): BrowserRun {
  if (rawRuns.length === 0) throw new Error("Cannot merge an empty browser run")
  return {
    ...rawRuns[0],
    repetitions: rawRuns.flatMap((run) => run.repetitions ?? [{ headline: run.headline, vitals: run.vitals }]),
    duration_ms: rawRuns.reduce((sum, result) => sum + result.duration_ms, 0),
    headline: mergeFrameMetrics(rawRuns[0].headline.label, rawRuns.map((result) => result.headline)),
    metrics: rawRuns[0].metrics.map((metric, index) =>
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
  "transcript-flick": transcriptFlick,
}

async function runFlow(scenario: ScenarioId, page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>) {
  return flowDrivers[scenario](page, app, fixture)
}
