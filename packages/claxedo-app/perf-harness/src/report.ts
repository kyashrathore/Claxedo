import { FRAME_120HZ_MS, FRAME_60HZ_MS, FRAMES_OVER_60HZ_ALLOWANCE, verdictLabel, type FrameMetric } from "./frame-sampler"
import { formatNumber } from "./stats"
import type { Budget, DiagnosticsOverheadEvidence, RunStatus, ScenarioResult } from "./types"

const DIAGNOSTICS_RETAINED_BYTES_BUDGET = 20 * 1024 * 1024

type Gateable = Omit<ScenarioResult, "budget" | "status" | "failures" | "warnings">

// The pass/warn/fail gate. The 8.33/16.67 thresholds are physical and fixed; the
// budget only adds a regression ceiling on the worst frame.
export function gateHeadline(headline: FrameMetric, budget: Budget) {
  const failures: string[] = []
  const warnings: string[] = []

  // Launch flows are load events, not interactions: their headline is time-to-ready
  // (completionMs), and a few heavy hydration frames are unavoidable. Frame drops on
  // a launch are reported as warnings; only a worst-frame regression fails them.
  const isLaunch = budget.scenario.startsWith("launch-")
  const note = (message: string) => (isLaunch ? warnings : failures).push(message)

  if (headline.p95FrameMs > FRAME_60HZ_MS) {
    note(`p95 frame ${formatNumber(headline.p95FrameMs)}ms > ${formatNumber(FRAME_60HZ_MS)}ms — sustained below 60hz`)
  }
  if (headline.framesOver1667 > FRAMES_OVER_60HZ_ALLOWANCE) {
    note(`${headline.framesOver1667} frames dropped below 60hz (allowance ${FRAMES_OVER_60HZ_ALLOWANCE})`)
  }
  if (typeof budget.worst_frame_ms === "number" && headline.worstFrameMs > budget.worst_frame_ms) {
    failures.push(`worst frame ${formatNumber(headline.worstFrameMs)}ms regressed past budget ${formatNumber(budget.worst_frame_ms)}ms`)
  }

  if (failures.length === 0 && warnings.length === 0 && headline.p95FrameMs > FRAME_120HZ_MS) {
    warnings.push(`p95 frame ${formatNumber(headline.p95FrameMs)}ms > ${formatNumber(FRAME_120HZ_MS)}ms — below the 120hz target`)
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
  const controlPhysical = gateHeadline(control, { scenario: budget.scenario })
  const failures = [
    enabled.p95FrameMs > control.p95FrameMs + Math.max(2, control.p95FrameMs * 0.1)
      ? `diagnostics moved p95 frame from ${formatNumber(control.p95FrameMs)}ms to ${formatNumber(enabled.p95FrameMs)}ms`
      : undefined,
    enabled.worstFrameMs > control.worstFrameMs + Math.max(5, control.worstFrameMs * 0.1)
      ? `diagnostics moved worst frame from ${formatNumber(control.worstFrameMs)}ms to ${formatNumber(enabled.worstFrameMs)}ms`
      : undefined,
    typeof budget.worst_frame_ms === "number"
      && control.worstFrameMs <= budget.worst_frame_ms
      && enabled.worstFrameMs > budget.worst_frame_ms
      ? `diagnostics moved worst frame past budget ${formatNumber(budget.worst_frame_ms)}ms (${formatNumber(control.worstFrameMs)}ms control → ${formatNumber(enabled.worstFrameMs)}ms enabled)`
      : undefined,
  ].filter((item): item is string => !!item)
  const warnings = [
    failures.length === 0 && enabled.p95FrameMs > control.p95FrameMs
      ? `diagnostics added ${formatNumber(enabled.p95FrameMs - control.p95FrameMs)}ms to paired p95 frame time`
      : undefined,
    typeof budget.worst_frame_ms === "number" && control.worstFrameMs > budget.worst_frame_ms
      ? `disabled control already exceeds stored worst-frame budget ${formatNumber(budget.worst_frame_ms)}ms (control ${formatNumber(control.worstFrameMs)}ms; enabled ${formatNumber(enabled.worstFrameMs)}ms)`
      : undefined,
    ...controlPhysical.failures.map((failure) => `disabled control base-app gate: ${failure}`),
    ...controlPhysical.warnings.map((warning) => `disabled control base-app gate: ${warning}`),
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
    return `| ${result.id} | ${verdictBadge(h.verdict)} | ${formatNumber(h.p95FrameMs)} | ${formatNumber(h.worstFrameMs)} | ${h.framesOver1667} | ${formatNumber(h.completionMs)} | ${result.status} | ${result.artifacts?.video ?? ""} |`
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
    results.some((result) => result.diagnostics)
      ? "Gate: two profiler-enabled and two disabled context-isolated runs execute in ABBA order across two benchmark browsers. Enabled evidence must stay within 10% (minimum 2ms p95 / 5ms worst-frame tolerance) of control and must not cross a stored worst-frame budget that control satisfies."
      : `Target: 120hz (frame <= ${formatNumber(FRAME_120HZ_MS)}ms). Floor: 60hz (frame <= ${formatNumber(FRAME_60HZ_MS)}ms).`,
    `Flows: ${results.length}  ·  pass: ${count(results, "pass")}  ·  warn: ${count(results, "warn")}  ·  fail: ${count(results, "fail")}`,
    "",
    `| Flow | ${results.some((result) => result.diagnostics) ? "Enabled frame verdict" : "Rate"} | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | ${results.some((result) => result.diagnostics) ? "Diagnostics status" : "Status"} | Video |`,
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...headlineRows,
  ]

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
