import { describe, expect, test } from "bun:test"

import {
  compareHeavyWorkspaceNoninferiority,
  type HeavyWorkspaceMetric,
  type HeavyWorkspaceReport,
} from "../src/heavy-workspace-noninferiority"

const phases = ["workspace_close", "workspace_reopen", "workspace_review_resume"] as const

function report(overrides: Record<string, Partial<HeavyWorkspaceMetric>> = {}): HeavyWorkspaceReport {
  const rows: HeavyWorkspaceMetric[] = []
  const add = (metric: string, value: number) => rows.push({
    metric,
    p50: value,
    p95: value,
    max: value,
    ...overrides[metric],
  })
  for (const phase of phases) {
    add(`${phase}_completion_ms`, 50)
    add(`${phase}_task_ms`, 20)
    add(`${phase}_script_ms`, 10)
    add(`${phase}_style_ms`, 5)
    add(`${phase}_layout_ms`, 2)
    add(`${phase}_p95_renderer_interval_ms`, 4)
    add(`${phase}_worst_renderer_interval_ms`, 12)
  }
  for (const metric of [
    "workspace_close_resource_requests",
    "workspace_reopen_blank_frames",
    "workspace_reopen_loading_frames",
    "workspace_reopen_resource_requests",
    "workspace_review_resume_blank_frames",
    "workspace_review_resume_loading_frames",
    "workspace_review_resume_resource_requests",
    "workspace_closed_shells_after_dwell",
    "workspace_closed_tabs_after_dwell",
    "workspace_closed_file_roots_after_dwell",
    "workspace_closed_navigators_after_dwell",
    "workspace_closed_review_roots_after_dwell",
    "workspace_closed_review_files_after_dwell",
    "workspace_reopen_inactive_review_roots",
    "workspace_reopen_inactive_review_files",
    "workspace_review_resume_inactive_file_roots",
  ]) add(metric, 0)
  add("workspace_disposal_required", 1)
  add("workspace_reopen_file_roots", 1)
  return { flows: [{ metrics: rows }] }
}

describe("heavy workspace retained-to-disposal noninferiority", () => {
  test("passes a zero-ownership candidate inside every predeclared latency and CPU tolerance", () => {
    expect(compareHeavyWorkspaceNoninferiority(report(), report()).status).toBe("pass")
  })

  test("fails a completion regression beyond max(5ms, 10%)", () => {
    const result = compareHeavyWorkspaceNoninferiority(report(), report({
      workspace_reopen_completion_ms: { p95: 56 },
    }))

    expect(result.status).toBe("fail")
    expect(result.checks).toContainEqual(expect.objectContaining({
      metric: "workspace_reopen_completion_ms",
      field: "p95",
      limit: 55,
      candidate: 56,
      pass: false,
    }))
  })

  test("fails missing evidence, retained hidden ownership, or an unexpected request increase", () => {
    const candidate = report({
      workspace_closed_review_files_after_dwell: { max: 500 },
      workspace_reopen_resource_requests: { max: 1 },
    })
    candidate.flows[0]!.metrics = candidate.flows[0]!.metrics.filter((row) => row.metric !== "workspace_close_task_ms")

    const result = compareHeavyWorkspaceNoninferiority(report(), candidate)

    expect(result.status).toBe("fail")
    expect(result.checks.filter((check) => !check.pass).map((check) => check.metric)).toEqual(expect.arrayContaining([
      "workspace_close_task_ms",
      "workspace_closed_review_files_after_dwell",
      "workspace_reopen_resource_requests",
    ]))
  })
})
