/** Shared record envelope with explicit metric semantics and measurement evidence.
 * Different instruments use distinct metric identifiers. A common unit alone does
 * not make observations comparable. Unsupported values are absent, never zero.
 */

/** Which implementation produced the numbers. The axis an experiment varies. */
export type StackId = string

/** The reference machine. The axis an experiment must hold fixed. */
export type ProfileId = string

/** Where the measurement came from. Lanes differ in mechanism, not in contract. */
export type LaneId = "browser" | "desktop" | "memory"

export type MetricDirection = "lower" | "higher"

export type MetricDefinition = {
  id: string
  unit: "ms" | "bytes" | "bytes/visit" | "count" | "score"
  direction: MetricDirection
  /** What the user experiences. Written so a non-web stack can implement it. */
  definition: string
  /** Where each stack sources it. Absent stack = does not supply this metric. */
  sources: Record<string, string>
  /** Absolute quality bands, where the metric has externally-defined ones. */
  thresholds?: { good: number; poor: number }
}

/** Definitions for records produced by the browser and memory lanes. */
export const METRICS: Record<string, MetricDefinition> = {
  time_to_first_content_ms: {
    id: "time_to_first_content_ms",
    unit: "ms",
    direction: "lower",
    definition: "From flow start until the user first sees meaningful content rather than empty chrome.",
    sources: {
      web: "First Contentful Paint",
      native: "first frame containing non-placeholder content",
    },
    thresholds: { good: 1800, poor: 3000 },
  },
  largest_content_ms: {
    id: "largest_content_ms",
    unit: "ms",
    direction: "lower",
    definition: "From flow start until the flow's primary content has finished appearing.",
    sources: {
      web: "Largest Contentful Paint",
      native: "frame at which the primary surface stops growing",
    },
    thresholds: { good: 2500, poor: 4000 },
  },
  flow_complete_ms: {
    id: "flow_complete_ms",
    unit: "ms",
    direction: "lower",
    definition: "From flow start until the user's goal is visibly done and the surface is usable.",
    sources: {
      web: "harness readiness predicate for the flow",
      native: "same predicate expressed against the native view tree",
    },
  },
  interaction_latency_ms: {
    id: "interaction_latency_ms",
    unit: "ms",
    direction: "lower",
    definition: "Input to visible response, at the 75th percentile of the flow's interactions.",
    sources: {
      web: "Interaction to Next Paint",
      native: "input event timestamp to the frame that reflects it",
    },
    thresholds: { good: 200, poor: 500 },
  },
  visual_stability: {
    id: "visual_stability",
    unit: "score",
    direction: "lower",
    definition: "How much content moved under the user without them causing it. 0 is perfectly still.",
    sources: {
      web: "Cumulative Layout Shift",
      native: "sum of unrequested view-rect displacement, viewport-normalised",
    },
    thresholds: { good: 0.1, poor: 0.25 },
  },
  renderer_task_worst_ms: {
    id: "renderer_task_worst_ms", unit: "ms", direction: "lower",
    definition: "Longest CrRendererMain RunTask in the measured interaction trace.",
    sources: { web: "CDP trace CrRendererMain RunTask" },
  },
  renderer_task_p95_ms: {
    id: "renderer_task_p95_ms", unit: "ms", direction: "lower",
    definition: "95th percentile of CrRendererMain RunTask durations in the measured interaction trace.",
    sources: { web: "CDP trace CrRendererMain RunTask" },
  },
  renderer_interval_worst_ms: {
    id: "renderer_interval_worst_ms", unit: "ms", direction: "lower",
    definition: "Longest rAF/LoAF interval attributed to renderer unavailability using the event-loop heartbeat.",
    sources: { web: "rAF, LoAF and event-loop heartbeat" },
  },
  renderer_interval_p95_ms: {
    id: "renderer_interval_p95_ms", unit: "ms", direction: "lower",
    definition: "95th percentile of rAF/LoAF intervals attributed to renderer unavailability.",
    sources: { web: "rAF, LoAF and event-loop heartbeat" },
  },
  observed_js_heap_bytes: {
    id: "observed_js_heap_bytes", unit: "bytes", direction: "lower",
    definition: "Observed JavaScript heap usage without forcing collection; not retained heap.",
    sources: { web: "CDP Performance.JSHeapUsedSize" },
  },
  retained_heap_bytes: {
    id: "retained_heap_bytes",
    unit: "bytes",
    direction: "lower",
    definition: "Memory still held after the flow settles and a collection runs. Retention, not allocation.",
    sources: {
      web: "JS heap after forced GC",
      native: "allocator live bytes after its equivalent",
    },
  },
  retained_heap_bytes_per_visit: {
    id: "retained_heap_bytes_per_visit",
    unit: "bytes/visit",
    direction: "lower",
    definition: "Regression slope of forced-GC JavaScript heap across repeated user visits after startup.",
    sources: {
      web: "least-squares slope of CDP Runtime.getHeapUsage.usedSize",
      native: "least-squares slope of allocator live bytes",
    },
  },
  retained_process_bytes: {
    id: "retained_process_bytes",
    unit: "bytes",
    direction: "lower",
    definition: "Resident memory of the whole application process tree once the flow settles.",
    sources: { web: "renderer + browser RSS", native: "process RSS" },
  },
}

export type MetricId = keyof typeof METRICS

/** One measured value, with the evidence needed to judge whether it moved. */
export type PerfRecord = {
  lane: LaneId
  /** The user task. Stable across implementations by construction. */
  flow: string
  metric: string
  /** Absent when the stack cannot supply this metric — never coerced to 0. */
  value?: number
  unit: MetricDefinition["unit"]
  /** Raw samples behind `value`, so variance is recoverable after the fact. */
  samples: number[]
  stack: StackId
  profile: ProfileId
  /** Commit the measurement describes, for attributing a move to a change. */
  commit?: string
  /** Why a value is absent, when it is. Blank absences are indistinguishable from bugs. */
  absentReason?: string
  evidence?: import("./measurement-context").MeasurementEvidence
}

export function metricDefinition(metric: string): MetricDefinition | undefined {
  return METRICS[metric]
}

/** Google's bands where they exist; undefined for metrics with no external standard. */
export function rateMetric(metric: string, value: number | undefined) {
  if (value === undefined) return "absent" as const
  const thresholds = METRICS[metric]?.thresholds
  if (!thresholds) return "unrated" as const
  if (value <= thresholds.good) return "good" as const
  return value <= thresholds.poor ? "needs-improvement" as const : "poor" as const
}
