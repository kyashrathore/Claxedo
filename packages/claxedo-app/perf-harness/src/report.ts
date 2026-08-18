import { webVitalRating } from "./web-vitals"

/** Google's good / needs-improvement / poor bands, as a glanceable badge. */
function ratingBadge(rating: ReturnType<typeof webVitalRating>) {
  if (rating === "good") return "🟢"
  if (rating === "needs-improvement") return "🟡"
  if (rating === "poor") return "🔴"
  return ""
}
import { FRAME_120HZ_MS, FRAME_60HZ_MS, FRAMES_OVER_60HZ_ALLOWANCE, verdictLabel, type FrameMetric } from "./frame-sampler"
import { formatNumber } from "./stats"
import type { Budget, DiagnosticsOverheadEvidence, RunStatus, ScenarioResult } from "./types"

const DIAGNOSTICS_RETAINED_BYTES_BUDGET = 20 * 1024 * 1024

type Gateable = Omit<ScenarioResult, "budget" | "status" | "failures" | "warnings">

// The browser gate applies 8.33/16.67ms to traced CrRendererMain task duration.
// Presented frames belong to the packaged Electron lane; the budget adds a
// regression ceiling on the worst renderer task.
export function gateHeadline(headline: FrameMetric, budget: Budget) {
  const failures: string[] = []
  const warnings = (headline.unattributedSchedulingGapsMs?.length ?? 0) > 0
    ? [`${headline.unattributedSchedulingGapsMs!.length} host/browser scheduling gaps in rAF had no matching main-thread unavailability or Long Animation Frame attribution and were excluded from the app gate`]
    : []

  if (headline.p95FrameMs > FRAME_60HZ_MS) {
    failures.push(`p95 renderer task ${formatNumber(headline.p95FrameMs)}ms > ${formatNumber(FRAME_60HZ_MS)}ms`)
  }
  if (headline.worstFrameMs > FRAME_60HZ_MS) {
    failures.push(`worst renderer task ${formatNumber(headline.worstFrameMs)}ms > ${formatNumber(FRAME_60HZ_MS)}ms — exceeded one 60hz main-thread budget`)
  }
  if (headline.framesOver1667 > FRAMES_OVER_60HZ_ALLOWANCE) {
    failures.push(`${headline.framesOver1667} of ${headline.sampleCount} renderer tasks exceeded the 60hz budget (allowance ${FRAMES_OVER_60HZ_ALLOWANCE})`)
  }
  if (typeof budget.worst_frame_ms === "number" && headline.worstFrameMs > budget.worst_frame_ms) {
    failures.push(`worst renderer task ${formatNumber(headline.worstFrameMs)}ms regressed past budget ${formatNumber(budget.worst_frame_ms)}ms`)
  }

  if (failures.length === 0 && warnings.length === 0 && headline.p95FrameMs > FRAME_120HZ_MS) {
    warnings.push(`p95 renderer task ${formatNumber(headline.p95FrameMs)}ms > ${formatNumber(FRAME_120HZ_MS)}ms — above one 120hz main-thread budget`)
  }

  return { status: resultStatus(failures, warnings), failures, warnings }
}

export function applyBudget(result: Gateable, budget: Budget): ScenarioResult {
  const headline = result.diagnostics
    ? gatePairedHeadline(result.diagnostics.controlHeadline, result.headline, budget)
    : gateHeadline(result.headline, budget)
  const diagnostics = result.diagnostics ? gateDiagnostics(result.diagnostics) : { failures: [], warnings: [] }
  const failures = [...headline.failures, ...diagnostics.failures]
  const warnings = [...headline.warnings, ...diagnostics.warnings]
  return { ...result, budget, status: resultStatus(failures, warnings), failures, warnings }
}

export function gatePairedHeadline(control: FrameMetric, enabled: FrameMetric, budget: Budget) {
  const p95Multiplier = process.env.CLAXEDO_PERF_HEADROOM ? Number(process.env.CLAXEDO_PERF_HEADROOM) : 0.1
  const worstMultiplier = process.env.CLAXEDO_PERF_HEADROOM ? Number(process.env.CLAXEDO_PERF_HEADROOM) : 0.1
  const controlPhysical = gateHeadline(control, { scenario: budget.scenario })
  const enabledPhysical = gateHeadline(enabled, { scenario: budget.scenario })
  const rawFailures = [
    enabled.p95FrameMs > control.p95FrameMs + Math.max(2, control.p95FrameMs * p95Multiplier)
      ? `diagnostics moved p95 frame from ${formatNumber(control.p95FrameMs)}ms to ${formatNumber(enabled.p95FrameMs)}ms`
      : undefined,
    enabled.worstFrameMs > control.worstFrameMs + Math.max(5, control.worstFrameMs * worstMultiplier)
      ? `diagnostics moved worst frame from ${formatNumber(control.worstFrameMs)}ms to ${formatNumber(enabled.worstFrameMs)}ms`
      : undefined,
    typeof budget.worst_frame_ms === "number"
      && control.worstFrameMs <= budget.worst_frame_ms
      && enabled.worstFrameMs > budget.worst_frame_ms
      ? `diagnostics moved worst frame past budget ${formatNumber(budget.worst_frame_ms)}ms (${formatNumber(control.worstFrameMs)}ms control → ${formatNumber(enabled.worstFrameMs)}ms enabled)`
      : undefined,
  ].filter((item): item is string => !!item)
  // A paired delta measures diagnostics overhead only when the disabled
  // control itself renders soundly. Both modes still enforce the renderer
  // frame floor independently; an unsound control only makes the relative
  // enabled-vs-control delta inconclusive.
  const controlUnsound =
    controlPhysical.failures.length > 0
    || control.p95FrameMs > FRAME_60HZ_MS
    || control.framesOver1667 > FRAMES_OVER_60HZ_ALLOWANCE
  const failures = [
    ...controlPhysical.failures.map((failure) => `disabled control base-app gate: ${failure}`),
    ...enabledPhysical.failures.map((failure) => `diagnostics-enabled base-app gate: ${failure}`),
    ...(controlUnsound ? [] : rawFailures),
  ]
  const warnings = [
    ...(controlUnsound
      ? rawFailures.map((failure) => `paired delta unmeasurable (control fails base-app gate): ${failure}`)
      : []),
    typeof budget.worst_frame_ms === "number" && control.worstFrameMs > budget.worst_frame_ms
      ? `disabled control already exceeds stored worst-frame budget ${formatNumber(budget.worst_frame_ms)}ms (control ${formatNumber(control.worstFrameMs)}ms; enabled ${formatNumber(enabled.worstFrameMs)}ms)`
      : undefined,
    ...controlPhysical.warnings.map((warning) => `disabled control base-app gate: ${warning}`),
    ...enabledPhysical.warnings.map((warning) => `diagnostics-enabled base-app gate: ${warning}`),
  ].filter((item): item is string => !!item)
  return { status: resultStatus(failures, warnings), failures, warnings }
}

export function gateDiagnostics(input: DiagnosticsOverheadEvidence) {
  const failures = [
    input.retainedBytes > DIAGNOSTICS_RETAINED_BYTES_BUDGET
      ? `diagnostics retained bytes ${String(input.retainedBytes)} > ${String(DIAGNOSTICS_RETAINED_BYTES_BUDGET)}`
      : undefined,
    input.collections === 0 || input.sampleCount === 0 || input.retainedProcesses === 0
      ? "diagnostics flow profiler produced no real process samples"
      : undefined,
    input.controlHeadline.label !== input.enabledHeadline.label
      ? "diagnostics enabled/control flow labels did not match"
      : undefined,
  ].filter((item): item is string => !!item)
  const warnings = input.droppedTicks > 0
    ? [`diagnostics dropped ${String(input.droppedTicks)} non-lifecycle sample ticks`]
    : []
  return { failures, warnings }
}

export function markdownReport(results: ScenarioResult[], options: { debug?: boolean } = {}) {
  const headlineRows = results.map((result) => {
    const h = result.headline
    return `| ${result.id} | ${verdictBadge(h.verdict)} | ${formatNumber(h.p95FrameMs)} | ${formatNumber(h.worstFrameMs)} | ${h.framesOver1667}/${h.sampleCount} | ${formatNumber(h.completionMs)} | ${result.status} | ${result.artifacts?.video ?? ""} |`
  })

  const failureRows = results.flatMap((result) =>
    [...result.failures, ...result.warnings].map(
      (note) => `| ${result.id} | ${note} | ${result.artifacts?.video ?? ""} |`,
    ),
  )

  const lines = [
    "# Claxedo Performance Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "Measurement: production web bundle in headless Chromium with synthetic route-level fixtures fulfilled over loopback. This is a renderer main-thread scheduling proxy, not actual FPS or packaged Electron compositor/GPU presentation.",
    results.some((result) => result.diagnostics)
      ? "Gate: two profiler-enabled and two disabled context-isolated runs execute in ABBA order across two benchmark browsers. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies."
      : `Target: 120hz (frame <= ${formatNumber(FRAME_120HZ_MS)}ms). Floor: 60hz (frame <= ${formatNumber(FRAME_60HZ_MS)}ms).`,
    `Flows: ${results.length}  ·  pass: ${count(results, "pass")}  ·  warn: ${count(results, "warn")}  ·  fail: ${count(results, "fail")}`,
    "",
    `| Flow | Renderer proxy | pooled p95 task (ms) | worst task (ms) | tasks >16.67ms | completion (ms) | ${results.some((result) => result.diagnostics) ? "Diagnostics status" : "Status"} | Video |`,
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...headlineRows,
  ]

  const vitalsRows = results
    .filter((result) => result.vitals)
    .map((result) => {
      const v = result.vitals!
      const cell = (metric: Parameters<typeof webVitalRating>[0], value: number | undefined, digits = 0) =>
        value === undefined ? "n/a" : `${value.toFixed(digits)} ${ratingBadge(webVitalRating(metric, value))}`
      return `| ${result.name} | ${cell("lcpMs", v.lcpMs)} | ${cell("inpMs", v.inpMs)} | ${cell("cls", v.cls, 3)} | ` +
        `${cell("fcpMs", v.fcpMs)} | ${cell("ttfbMs", v.ttfbMs)} | ${v.interactionCount} |`
    })

  if (vitalsRows.length) {
    const env = results.find((result) => result.environment)?.environment
    lines.push(
      "",
      "## Core Web Vitals",
      "",
      `Reference machine: ${env ? env.label : "unknown"}. These are what a user perceives — when content appeared, whether it moved, how fast the UI answered input — as opposed to the renderer-scheduling proxy above.`,
      "Caveat: API and SSE responses are fulfilled in-process from fixtures, so their latency is the profile's simulated round trip rather than a real server. Asset delivery IS really throttled, so the load metrics (LCP/FCP/TTFB) carry the bundle's true cost at this bandwidth.",
      "",
      "| Flow | LCP (ms) | INP (ms) | CLS | FCP (ms) | TTFB (ms) | interactions |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...vitalsRows,
    )
  }

  const comparisonRows = results.flatMap((result) =>
    (result.comparison ?? [])
      .filter((item) => item.verdict !== "new" || item.current !== undefined)
      .map((item) => {
        const mark = item.verdict === "improved" ? "🟢 improved"
          : item.verdict === "regressed" ? "🔴 regressed"
          : item.verdict === "absent" ? "⚪ absent"
          : item.verdict === "new" ? "🆕 new"
          : "· unchanged"
        const delta = item.deltaPct === undefined ? "—" : `${item.deltaPct > 0 ? "+" : ""}${item.deltaPct.toFixed(1)}%`
        const shown = (value: number | undefined) => value === undefined ? "absent" : value.toFixed(value < 10 ? 3 : 0)
        return `| ${result.name} | ${item.metric} | ${shown(item.baseline)} | ${shown(item.current)} | ${delta} | ±${item.tolerancePct.toFixed(0)}% | ${mark} |`
      }),
  )

  if (comparisonRows.length) {
    const env = results.find((result) => result.environment)?.environment
    lines.push(
      "",
      "## Against baseline",
      "",
      `Comparing this run to the tracked baseline for the same profile and stack (${env?.label ?? "unknown machine"}). ` +
      "Tolerance is two standard deviations of the baseline's own samples, floored at 5% — a move inside it is reported as unchanged rather than as a win, because this machine's run-to-run spread is wide enough to manufacture one.",
      "",
      "| Flow | Metric | Baseline | Current | Delta | Tolerance | Verdict |",
      "| --- | --- | ---: | ---: | ---: | ---: | --- |",
      ...comparisonRows,
    )
  }

  if (failureRows.length) {
    lines.push(
      "",
      "## Findings",
      "",
      "| Flow | Note | Video |",
      "| --- | --- | --- |",
      ...failureRows,
    )
  }

  if (options.debug) {
    const debugRows = results.flatMap((result) =>
      result.metrics.map(
        (metric) => `| ${result.id} | ${metric.metric} | ${formatNumber(metric.p50)} | ${formatNumber(metric.p95)} | ${metric.unit} |`,
      ),
    )
    if (debugRows.length) {
      lines.push(
        "",
        "## Debug sub-metrics",
        "",
        "| Flow | Sub-metric | p50 | p95 | Unit |",
        "| --- | --- | ---: | ---: | --- |",
        ...debugRows,
      )
    }
    const diagnosticsRows = results.flatMap((result) =>
      result.diagnostics
        ? [[
            result.id,
            String(result.diagnostics.retainedBytes),
            String(result.diagnostics.retainedProcesses),
            String(result.diagnostics.droppedTicks),
            formatNumber(result.diagnostics.maxSourceDurationMs),
            formatNumber(result.diagnostics.maxReconciliationDurationMs),
            formatNumber(result.diagnostics.controlHeadline.p95FrameMs),
            formatNumber(result.diagnostics.enabledHeadline.p95FrameMs),
          ]]
        : [])
    if (diagnosticsRows.length) {
      lines.push(
        "",
        "## Diagnostics overhead",
        "",
        "| Flow | Retained bytes | Processes | Dropped ticks | Max source (ms) | Max reconciliation (ms) | Control p95 (ms) | Enabled p95 (ms) |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ...diagnosticsRows.map((row) => `| ${row.join(" | ")} |`),
      )
    }
  }

  lines.push("")
  return lines.join("\n")
}

export function jsonReport(results: ScenarioResult[]) {
  return {
    generated_at: new Date().toISOString(),
    status: overallStatus(results),
    targets: { rate_target_hz: 120, rate_floor_hz: 60 },
    flows: results,
  }
}

export function overallStatus(results: ScenarioResult[]): RunStatus {
  if (results.some((result) => result.status === "fail")) return "fail"
  if (results.some((result) => result.status === "warn")) return "warn"
  return "pass"
}

function count(results: ScenarioResult[], status: RunStatus) {
  return results.filter((result) => result.status === status).length
}

function verdictBadge(verdict: FrameMetric["verdict"]) {
  if (verdict === "green") return `🟢 ${verdictLabel(verdict)}`
  if (verdict === "amber") return `🟡 ${verdictLabel(verdict)}`
  return `🔴 ${verdictLabel(verdict)}`
}

function resultStatus(failures: string[], warnings: string[]): RunStatus {
  return failures.length ? "fail" : warnings.length ? "warn" : "pass"
}
