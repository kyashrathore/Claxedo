import { isRecord, numberField, textField } from "./json-fields"

export type HeavyWorkspaceMetric = {
  metric: string
  p50: number
  p95: number
  max: number
}

export type HeavyWorkspaceReport = {
  flows: Array<{ metrics: HeavyWorkspaceMetric[] }>
}

/**
 * Read a stored heavy-workspace report.
 *
 * Lives beside the type it produces, so the CLI that compares two report files
 * does not have to assert each one into shape. A flow whose metrics cannot be
 * read is dropped, which the comparison then reports as a missing metric rather
 * than as a silent pass.
 */
export function parseHeavyWorkspaceReport(value: unknown): HeavyWorkspaceReport {
  if (!isRecord(value) || !Array.isArray(value.flows)) return { flows: [] }
  return {
    flows: value.flows.filter(isRecord).map((flow) => ({
      metrics: (Array.isArray(flow.metrics) ? flow.metrics : []).filter(isRecord).flatMap((entry) => {
        const metric = textField(entry, "metric")
        const p50 = numberField(entry, "p50")
        const p95 = numberField(entry, "p95")
        const max = numberField(entry, "max")
        if (metric === undefined || p50 === undefined || p95 === undefined || max === undefined) return []
        return [{ metric, p50, p95, max }]
      }),
    })),
  }
}

export type HeavyWorkspaceNoninferiorityCheck = {
  metric: string
  field: "p50" | "p95" | "max"
  baseline?: number
  candidate?: number
  limit: number
  pass: boolean
}

export function compareHeavyWorkspaceNoninferiority(
  baseline: HeavyWorkspaceReport,
  candidate: HeavyWorkspaceReport,
) {
  const baselineMetrics = metricMap(baseline)
  const candidateMetrics = metricMap(candidate)
  const checks: HeavyWorkspaceNoninferiorityCheck[] = []

  const bounded = (
    metric: string,
    field: HeavyWorkspaceNoninferiorityCheck["field"],
    absoluteTolerance: number,
    relativeTolerance = 0.1,
  ) => {
    const before = baselineMetrics.get(metric)?.[field]
    const after = candidateMetrics.get(metric)?.[field]
    const limit = before === undefined ? Number.NaN : before + Math.max(absoluteTolerance, before * relativeTolerance)
    checks.push({
      metric,
      field,
      baseline: before,
      candidate: after,
      limit,
      pass: before !== undefined && after !== undefined && after <= limit,
    })
  }
  const noIncrease = (metric: string) => bounded(metric, "max", 0, 0)
  const exact = (metric: string, field: HeavyWorkspaceNoninferiorityCheck["field"], expected: number) => {
    const value = candidateMetrics.get(metric)?.[field]
    checks.push({ metric, field, candidate: value, limit: expected, pass: value === expected })
  }

  for (const phase of ["workspace_close", "workspace_reopen", "workspace_review_resume"] as const) {
    bounded(`${phase}_completion_ms`, "p50", 5)
    bounded(`${phase}_completion_ms`, "p95", 5)
    bounded(`${phase}_task_ms`, "p95", 2)
    bounded(`${phase}_script_ms`, "p95", 1)
    bounded(`${phase}_style_ms`, "p95", 1)
    bounded(`${phase}_layout_ms`, "p95", 1)
    bounded(`${phase}_p95_renderer_interval_ms`, "p95", 2)
    bounded(`${phase}_worst_renderer_interval_ms`, "p95", 5)
  }

  for (const metric of [
    "workspace_close_resource_requests",
    "workspace_reopen_blank_frames",
    "workspace_reopen_loading_frames",
    "workspace_reopen_resource_requests",
    "workspace_review_resume_blank_frames",
    "workspace_review_resume_loading_frames",
    "workspace_review_resume_resource_requests",
  ]) noIncrease(metric)

  exact("workspace_disposal_required", "max", 1)
  for (const metric of [
    "workspace_closed_shells_after_dwell",
    "workspace_closed_tabs_after_dwell",
    "workspace_closed_file_roots_after_dwell",
    "workspace_closed_navigators_after_dwell",
    "workspace_closed_review_roots_after_dwell",
    "workspace_closed_review_files_after_dwell",
    "workspace_file_restore_inactive_review_roots",
    "workspace_file_restore_inactive_review_files",
    "workspace_review_resume_inactive_file_roots",
  ]) exact(metric, "max", 0)
  exact("workspace_file_restore_file_roots", "max", 1)

  return {
    status: checks.every((check) => check.pass) ? "pass" as const : "fail" as const,
    checks,
  }
}

function metricMap(report: HeavyWorkspaceReport) {
  return new Map(report.flows.flatMap((flow) => flow.metrics).map((metric) => [metric.metric, metric]))
}
