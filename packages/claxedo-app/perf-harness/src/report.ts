import { FRAME_120HZ_MS, FRAME_60HZ_MS, FRAMES_OVER_60HZ_ALLOWANCE, verdictLabel, type FrameMetric } from "./frame-sampler"
import { formatNumber } from "./stats"
import type { Budget, RunStatus, ScenarioResult } from "./types"

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

  const status: RunStatus = failures.length ? "fail" : warnings.length ? "warn" : "pass"
  return { status, failures, warnings }
}

export function applyBudget(result: Gateable, budget: Budget): ScenarioResult {
  const { status, failures, warnings } = gateHeadline(result.headline, budget)
  return { ...result, budget, status, failures, warnings }
}

export function markdownReport(results: ScenarioResult[], options: { debug?: boolean } = {}) {
  const headlineRows = results.map((result) => {
    const h = result.headline
    return `| ${result.id} | ${verdictBadge(h.verdict)} | ${formatNumber(h.p95FrameMs)} | ${formatNumber(h.worstFrameMs)} | ${h.framesOver1667} | ${formatNumber(h.completionMs)} | ${statusBadge(result.status)} | ${result.artifacts?.video ?? ""} |`
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
    `Target: 120hz (frame <= ${formatNumber(FRAME_120HZ_MS)}ms). Floor: 60hz (frame <= ${formatNumber(FRAME_60HZ_MS)}ms).`,
    `Flows: ${results.length}  ·  pass: ${count(results, "pass")}  ·  warn: ${count(results, "warn")}  ·  fail: ${count(results, "fail")}`,
    "",
    "| Flow | Rate | p95 frame (ms) | worst frame (ms) | frames <60hz | completion (ms) | Status | Video |",
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

function statusBadge(status: RunStatus) {
  if (status === "pass") return "pass"
  if (status === "warn") return "warn"
  return "fail"
}
