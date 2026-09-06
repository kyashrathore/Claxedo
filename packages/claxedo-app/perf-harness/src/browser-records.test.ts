import { expect, test } from "bun:test"
import { buildFrameMetric, mergeFrameMetrics } from "./frame-sampler"
import { mergeBrowserRuns } from "./browser-runner"
import { browserRecords } from "./browser-records"
import { browserPublication, publishBrowserResult } from "./browser-publication"
import { context, source } from "./measurement-fixture.test-support"
import { baselineFromRecords, compareToBaseline, readBaselineFor } from "./baseline-store"
import { rm } from "node:fs/promises"
import path from "node:path"
import { dataRoot } from "./storage"
import type { ScenarioResult } from "./types"

function result(headline = buildFrameMetric("session-switch", [8], [], 10, undefined, [], [2, 4])): ScenarioResult {
  return {
    adapter: "browser", target: "claxedo", id: "session-switch", name: "Switch", started_at: new Date(0).toISOString(),
    duration_ms: 10, seed: { repos: 1, sessions: 2, messages: 10, terminals: 0, changed_files: 0, projects: 1, themes: [], agent_actions: 0, mask_keys: [] },
    headline, metrics: [], budget: { scenario: "session-switch" }, status: "pass", failures: [], warnings: [], context,
  }
}

test("portable records preserve whole-flow samples across nested merges", () => {
  const first = result(mergeFrameMetrics("session-switch", [
    buildFrameMetric("click-one", [8], [], 10, undefined, [], [2, 4]),
    buildFrameMetric("click-two", [8], [], 30, undefined, [], [1, 6]),
  ]))
  const second = result(buildFrameMetric("session-switch", [8], [], 40, undefined, [], [3, 8]))
  const merged = { ...result(), ...mergeBrowserRuns([mergeBrowserRuns([first]), mergeBrowserRuns([second])]) }
  const records = browserRecords(merged, "solid-1")
  expect(records.find((r) => r.metric === "flow_complete_ms")!.samples).toEqual([20, 40])
  expect(records.find((r) => r.metric === "renderer_task_worst_ms")!.samples).toEqual([6, 8])
  expect(records.find((r) => r.metric === "renderer_task_p95_ms")!.samples).toEqual([6, 8])
  expect(records.some((r) => r.metric === "retained_heap_bytes")).toBe(false)
})

test("rAF interval and renderer-task populations have distinct identities", () => {
  const intervals = browserRecords(result(buildFrameMetric("switch", [8, 10], [], 20)), "solid-1")
  expect(intervals.find((r) => r.metric === "renderer_interval_worst_ms")!.value).toBe(10)
  expect(intervals.some((r) => r.metric === "renderer_task_worst_ms")).toBe(false)
  const mixed = result(mergeFrameMetrics("mixed", [result().headline, buildFrameMetric("raf", [8], [], 10)]))
  expect(browserPublication(mixed, true).allowed).toBe(false)
})

test("invalid, failed, attribution and unsound-control runs cannot publish", async () => {
  const invalid = result()
  await publishBrowserResult(invalid, { stack: "solid-1", accept_baseline: true, append_trend: true }, false, source)
  expect(invalid.status).toBe("fail")
  expect(invalid.failures).toContain("Baseline refused: scenario evidence is invalid")
  expect(browserPublication(result(), true).allowed).toBe(true)
  expect(browserPublication({ ...result(), status: "fail" }, true).allowed).toBe(false)
  expect(browserPublication({ ...result(), context: { ...context, suite: "attribution" } }, true).allowed).toBe(false)
  expect(browserPublication({ ...result(), context: { ...context, suite: "diagnostics" }, warnings: ["disabled control base-app gate: slow"] }, true).allowed).toBe(false)
})


test("an empty repetition cannot supply zero-valued timing samples", () => {
  const merged = { ...result(), ...mergeBrowserRuns([
    result(buildFrameMetric("switch", [], [], 10)),
    result(buildFrameMetric("switch", [5, 6, 7], [], 20)),
  ]) }
  expect(browserPublication(merged, true).allowed).toBe(false)
  const records = browserRecords(merged, "solid-1")
  expect(records.find((record) => record.metric === "renderer_interval_worst_ms")).toMatchObject({ samples: [] })
  expect(records.find((record) => record.metric === "renderer_interval_worst_ms")!.value).toBeUndefined()
})

test("post-input LCP ordering does not change the portable frozen LCP", () => {
  const runs = [[9000, 100], [1000, 900], [8000, 200]].map(([lcpMs, lcpAtFirstTrustedInputMs]) => ({
    ...result(), vitals: { interactionCount: 1, lcpMs, lcpAtFirstTrustedInputMs },
  }))
  const records = browserRecords({ ...result(), ...mergeBrowserRuns(runs) }, "solid-1")
  expect(records.find((record) => record.metric === "largest_content_ms")).toMatchObject({ value: 900, samples: [100, 900, 200] })
})

test("one truncated shift buffer makes the entire CLS measurement absent while valid metrics still publish", async () => {
  const profile = `test-truncated-cls-${crypto.randomUUID()}`
  const clean = {
    ...result(), environment: { profile, label: "isolated test" },
    vitals: { interactionCount: 0, fcpMs: 100, clsExcludingSyntheticInput: 0.1 },
  }
  const truncated = {
    ...clean,
    vitals: { interactionCount: 0, fcpMs: 200, clsExcludingSyntheticInput: 0.01, shiftsTruncated: true, shiftCount: 2000 },
  }
  const current = { ...result(), ...mergeBrowserRuns([clean, truncated]) }
  const records = browserRecords(current, "solid-1")
  const cls = records.find((record) => record.metric === "visual_stability")!
  expect(cls.value).toBeUndefined()
  expect(cls.samples).toEqual([])
  expect(cls.absentReason).toBe("layout-shift buffer truncated in one or more repetitions")
  expect(compareToBaseline(records, baselineFromRecords(browserRecords(clean, "solid-1")))
    .find((comparison) => comparison.metric === "visual_stability")!.verdict).toBe("absent")

  try {
    await publishBrowserResult(current, { stack: "solid-1", accept_baseline: true, append_trend: false }, true, source)
    expect(current.status).toBe("pass")
    const baseline = await readBaselineFor({ profile, stack: "solid-1", lane: "browser", flow: current.id, suite: "renderer" })
    expect(baseline!.metrics.visual_stability.value).toBeUndefined()
    expect(baseline!.metrics.visual_stability.samples).toEqual([])
    expect(baseline!.metrics.visual_stability.absentReason).toBe(cls.absentReason)
    expect(baseline!.metrics.time_to_first_content_ms).toMatchObject({ value: 200, samples: [100, 200] })
    expect(baseline!.metrics.renderer_task_worst_ms).toMatchObject({ value: 4, samples: [4, 4] })
  } finally {
    await rm(path.join(dataRoot, "baselines", profile), { recursive: true, force: true })
  }
})


test("valid publication persists one suite-scoped baseline with authoritative source", async () => {
  const profile = `test-publication-${crypto.randomUUID()}`
  const current = { ...result(), environment: { profile, label: "isolated test" } }
  try {
    await publishBrowserResult(current, { stack: "solid-1", accept_baseline: true, append_trend: false }, true, source)
    const baseline = await readBaselineFor({ profile, stack: "solid-1", lane: "browser", flow: current.id, suite: "renderer" })
    expect(baseline!.sourceIdentity).toEqual(source.sourceIdentity)
    expect(baseline!.metrics.renderer_task_worst_ms.samples).toEqual([4])
    expect(baseline!.metrics.renderer_task_worst_ms.evidence!.context.host).toEqual(context.host)
    expect(await readBaselineFor({ profile, stack: "solid-1", lane: "browser", flow: current.id, suite: "diagnostics" })).toBeUndefined()
  } finally {
    await rm(path.join(dataRoot, "baselines", profile), { recursive: true, force: true })
  }
})

test("invalid evidence fails without an explicit promotion request", async () => {
  for (const current of [result({ ...result().headline, completionMs: NaN }), result({ ...result().headline, sampleCount: 0 })]) {
    await publishBrowserResult(current, { stack: "solid-1", accept_baseline: false, append_trend: true }, true, source)
    expect(current.status).toBe("fail")
    expect(current.comparison).toBeUndefined()
  }
  const raced = result()
  await publishBrowserResult(raced, { stack: "solid-1", accept_baseline: false, append_trend: true }, true, { ...source, sourceStable: false })
  expect(raced.status).toBe("fail")
  expect(raced.failures.join(" ")).toContain("source")
})
