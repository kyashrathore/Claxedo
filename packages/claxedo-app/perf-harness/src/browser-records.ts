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
    // The FROZEN LCP, for the same reason INP below needs a trusted interaction
    // — and it is the same defect, one metric over. The platform stops revising
    // LCP at the first trusted input; synthetic in-page `element.click()` is
    // untrusted and does not stop it. A flow driven only synthetically keeps
    // collecting candidates until it ends, so `vitals.lcpMs` there is the
    // largest paint in the WHOLE FLOW — routinely a transcript message the flow
    // itself caused to render — reported under a metric whose thresholds mean
    // "when the page finished loading". Recording that number scored three of
    // five flows "poor" against bands that never applied to it.
    record(
      "largest_content_ms",
      vitals?.lcpAtFirstTrustedInputMs,
      vitals?.lcpAtFirstTrustedInputMs === undefined ? [] : [vitals.lcpAtFirstTrustedInputMs],
      "flow drives no trusted input, so LCP never finalised and no largest-content time exists to report",
    ),
    record("flow_complete_ms", headline.completionMs, [headline.completionMs]),
    // INP needs a trusted interaction. A flow driven by synthetic in-page
    // clicks produces none, and reporting 0 there would read as instant.
    record(
      "interaction_latency_ms",
      vitals?.interactionCount ? vitals.inpMs : undefined,
      vitals?.inpMs === undefined ? [] : [vitals.inpMs],
      "flow drives no trusted input, so no interaction latency exists to report",
    ),
    // The contract defines this as movement "without them causing it", which is
    // exactly the rule Chromium applies via `hadRecentInput` — and applies only
    // to trusted input. A synthetic click stands in for a real one everywhere
    // else in the flow, so it has to stand in here too, or the flow is charged
    // for the rearrangement its own click asked for. On workspace-switch that
    // is 96% of the score: 0.319 observed against 0.013 under real input.
    record(
      "visual_stability",
      vitals?.clsExcludingSyntheticInput,
      vitals?.clsExcludingSyntheticInput === undefined ? [] : [vitals.clsExcludingSyntheticInput],
      "flow reported no layout shifts to score",
    ),
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
