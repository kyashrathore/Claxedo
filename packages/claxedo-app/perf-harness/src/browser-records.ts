import type { ScenarioResult } from "./types"
import { METRICS, type PerfRecord } from "./perf-record"
import { percentile } from "./stats"
import type { WebVitals } from "./web-vitals"

/** Samples are whole-flow repetitions, never individual tasks or nested clicks. */
export function browserRecords(result: ScenarioResult, stack: string): PerfRecord[] {
  const repetitions = result.repetitions ?? [{ headline: result.headline, vitals: result.vitals }]
  const base = { lane: "browser" as const, flow: result.id, stack, profile: result.environment?.profile ?? "unthrottled" }
  const record = (metric: string, value: number | undefined, samples: number[], method: string, absentReason = "measurement was unavailable"): PerfRecord => ({
    ...base, metric, unit: METRICS[metric].unit, samples,
    ...(value === undefined ? { absentReason } : { value }),
    ...(result.context ? { evidence: { definitionVersion: 2, method, context: result.context } } : {}),
  })
  const vital = (metric: string, read: (vitals: WebVitals | undefined) => number | undefined, method: string, reason?: string) => {
    const samples = repetitions.flatMap((run) => {
      const value = read(run.vitals)
      return value === undefined ? [] : [value]
    })
    return record(metric, samples.length ? percentile(samples, 75) : undefined, samples, method, reason)
  }
  const complete = repetitions.every((run) => run.headline.sampleCount > 0)
  const methods = new Set(repetitions.map((run) => run.headline.method))
  const method = methods.size === 1 ? result.headline.method : "mixed"
  const task = method === "renderer-task-v1"
  const frameAvailable = complete && (task || method === "renderer-interval-v1")
  const heap = result.headline.causal?.performance?.jsHeapUsedBytes
  const shiftsTruncated = repetitions.some((run) => run.vitals?.shiftsTruncated)
  return [
    vital("time_to_first_content_ms", (v) => v?.fcpMs, "paint-timing-fcp-v1"),
    vital("largest_content_ms", (v) => v?.lcpAtFirstTrustedInputMs, "trusted-input-frozen-lcp-v1", "no LCP frozen by trusted input"),
    record("flow_complete_ms", complete ? result.headline.completionMs : undefined, complete ? repetitions.map((run) => run.headline.completionMs) : [], "scenario-readiness-v1"),
    vital("interaction_latency_ms", (v) => v?.interactionCount ? v.inpMs : undefined, "event-timing-inp-v1", "no trusted interaction latency"),
    vital("visual_stability", (v) => shiftsTruncated ? undefined : v?.clsExcludingSyntheticInput, "input-filtered-cls-v1",
      shiftsTruncated ? "layout-shift buffer truncated in one or more repetitions" : undefined),
    record(task ? "renderer_task_worst_ms" : "renderer_interval_worst_ms", frameAvailable ? result.headline.worstFrameMs : undefined,
      frameAvailable ? repetitions.map((run) => run.headline.worstFrameMs) : [], method ?? "unknown", "incompatible or unidentified renderer measurement methods"),
    record(task ? "renderer_task_p95_ms" : "renderer_interval_p95_ms", frameAvailable ? result.headline.p95FrameMs : undefined,
      frameAvailable ? repetitions.map((run) => run.headline.p95FrameMs) : [], method ?? "unknown", "incompatible or unidentified renderer measurement methods"),
    record("observed_js_heap_bytes", heap, repetitions.flatMap((run) => {
      const value = run.headline.causal?.performance?.jsHeapUsedBytes
      return value === undefined ? [] : [value]
    }), "cdp-observed-heap-without-gc-v1", "causal window did not report heap usage"),
  ]
}
