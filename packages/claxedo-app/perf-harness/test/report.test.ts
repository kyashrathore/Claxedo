import { expect, test } from "bun:test"
import { jsonReport, markdownReport, perClickNavigationRows } from "../src/report"
import type { MetricSummary, ScenarioResult } from "../src/types"

function metric(name: string, samples: number[], unit = "ms"): MetricSummary {
  return {
    metric: name,
    value: samples.at(-1) ?? 0,
    unit,
    direction: "lower",
    samples,
    p50: samples[0] ?? 0,
    p95: samples.at(-1) ?? 0,
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    relative_stddev: 0,
  }
}

function sessionSwitchResult(): ScenarioResult {
  return {
    adapter: "browser",
    target: "claxedo",
    id: "session-switch",
    name: "Session switch",
    started_at: "2026-08-23T00:00:00.000Z",
    duration_ms: 1_000,
    seed: {
      repos: 1,
      sessions: 2,
      messages: 20_000,
      terminals: 0,
      changed_files: 0,
      projects: 1,
      themes: [],
      agent_actions: 0,
      mask_keys: [],
    },
    headline: {
      label: "session-switch",
      worstFrameMs: 10,
      p95FrameMs: 8,
      framesOver833: 1,
      framesOver1667: 0,
      sampleCount: 10,
      completionMs: 100,
      verdict: "green",
    },
    metrics: [
      metric("switch_02_warm_nodes_removed", [4, 5], "count"),
      metric("switch_01_cold_style_ms", [127, 128]),
      metric("switch_02_warm_completion_ms", [30, 31]),
      metric("switch_01_cold_nodes_added", [1_980, 1_981], "count"),
      metric("switch_02_warm_script_ms", [12, 13]),
      metric("switch_01_cold_completion_ms", [1_628, 1_629]),
      metric("switch_02_warm_layout_ms", [7, 8]),
      metric("switch_01_cold_script_ms", [49, 50]),
      metric("switch_02_warm_nodes_added", [4, 6], "count"),
      metric("switch_01_cold_layout_ms", [75, 76]),
      metric("switch_02_warm_style_ms", [18, 21]),
      metric("switch_01_cold_nodes_removed", [20, 21], "count"),
    ],
    budget: { scenario: "session-switch" },
    status: "pass",
    failures: [],
    warnings: [],
  }
}

test("per-click navigation rows preserve every raw physical-click sample", () => {
  expect(perClickNavigationRows([sessionSwitchResult()])).toEqual([
    {
      flow: "session-switch",
      sample: 1,
      click: 1,
      state: "cold",
      completion_ms: 1_628,
      script_ms: 49,
      style_ms: 127,
      layout_ms: 75,
      nodes_added: 1_980,
      nodes_removed: 20,
    },
    {
      flow: "session-switch",
      sample: 1,
      click: 2,
      state: "warm",
      completion_ms: 30,
      script_ms: 12,
      style_ms: 18,
      layout_ms: 7,
      nodes_added: 4,
      nodes_removed: 4,
    },
    {
      flow: "session-switch",
      sample: 2,
      click: 1,
      state: "cold",
      completion_ms: 1_629,
      script_ms: 50,
      style_ms: 128,
      layout_ms: 76,
      nodes_added: 1_981,
      nodes_removed: 21,
    },
    {
      flow: "session-switch",
      sample: 2,
      click: 2,
      state: "warm",
      completion_ms: 31,
      script_ms: 13,
      style_ms: 21,
      layout_ms: 8,
      nodes_added: 6,
      nodes_removed: 5,
    },
  ])
})

test("default reports prominently publish raw click rows and label cumulative inputs as source counters", () => {
  const result = sessionSwitchResult()
  const markdown = markdownReport([result])
  const json = jsonReport([result])

  expect(markdown).toContain("## Raw per-click navigation deltas")
  expect(markdown).toContain("One row is one physical click sample")
  expect(markdown).toContain("cumulative source counters")
  expect(markdown).toContain("| session-switch | 1 | 1 | cold | 1628 | 49 | 127 | 75 | 1980 | 20 |")
  expect(markdown).toContain("| session-switch | 2 | 2 | warm | 31 | 13 | 21 | 8 | 6 | 5 |")
  expect(markdown).not.toContain("## Debug sub-metrics")
  expect(json.per_click_navigation.measurement).toBe("raw after-minus-before delta per physical click")
  expect(json.per_click_navigation.source_counters_only.style_ms).toContain("RecalcStyleDuration")
  expect(json.per_click_navigation.rows).toHaveLength(4)
})
