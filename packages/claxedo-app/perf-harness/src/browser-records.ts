import type { ScenarioResult } from "./types"
import { METRICS, type PerfRecord } from "./perf-record"

/**
 * Project the browser lane's result onto the portable contract.
 *
 * A translation layer on purpose. `FrameMetric` and `WebVitals` are shaped by
 * what Chromium happens to expose; `PerfRecord` is shaped by what a user
 * experiences. Keeping the mapping in one function is what lets a second stack
 * — Solid 2 behind the same flows, or a native build behind its own driver —
 * emit the same records without inheriting Chromium's vocabulary.
 */
export function browserRecords(result: ScenarioResult, stack: string): PerfRecord[] {
  const profile = result.environment?.profile ?? "unthrottled"
  const vitals = result.vitals
  const headline = result.headline
  const base = { lane: "browser" as const, flow: result.id, stack, profile }

  const record = (
    metric: string,
    value: number | undefined,
    samples: number[],
    absentReason?: string,
  ): PerfRecord => ({
    ...base,
    metric,
    ...(value === undefined ? {} : { value }),
    unit: METRICS[metric]!.unit,
    samples,
    ...(value === undefined && absentReason ? { absentReason } : {}),
  })

  return [
    record("time_to_first_content_ms", vitals?.fcpMs, vitals?.fcpMs === undefined ? [] : [vitals.fcpMs]),
    record("largest_content_ms", vitals?.lcpMs, vitals?.lcpMs === undefined ? [] : [vitals.lcpMs]),
    record("flow_complete_ms", headline.completionMs, [headline.completionMs]),
    // INP needs a trusted interaction. A flow driven by synthetic in-page
    // clicks produces none, and reporting 0 there would read as instant.
    record(
      "interaction_latency_ms",
      vitals?.interactionCount ? vitals.inpMs : undefined,
      vitals?.inpMs === undefined ? [] : [vitals.inpMs],
      "flow drives no trusted input, so no interaction latency exists to report",
    ),
    record("visual_stability", vitals?.cls, vitals?.cls === undefined ? [] : [vitals.cls]),
    // Samples are repeated measurements OF THIS METRIC, not the distribution
    // underneath it. Passing every main-thread task here made the tolerance for
    // "worst frame" ±1787%: a spread computed over thousands of sub-millisecond
    // tasks and a handful of long ones, which no real regression could exceed.
    record("worst_frame_ms", headline.worstFrameMs, [headline.worstFrameMs]),
    record("frame_p95_ms", headline.p95FrameMs, [headline.p95FrameMs]),
    record(
      "retained_heap_bytes",
      result.diagnostics?.enabledHeadline?.causal?.performance?.jsHeapUsedBytes,
      [],
      "browser lane reports heap only under causal diagnostics",
    ),
  ]
}
