/**
 * The portable measurement contract.
 *
 * Everything this harness measures — today's Solid renderer, a Solid 2 port, a
 * native GPUI build, the desktop shell, memory ceilings — reduces to one record
 * shape. The point is comparability across IMPLEMENTATIONS, not just across
 * commits: an experiment like "is Solid 2 faster" is answered by holding
 * `flow` and `profile` fixed and varying `stack`, which only works if the
 * vocabulary on both sides means the same thing.
 *
 * That forces two rules on everything below:
 *
 *  1. A `flow` names a USER TASK ("switch between two sessions"), never a code
 *     path. A flow id has to survive a total rewrite of the thing that
 *     implements it, or the rewrite has nothing to compare against.
 *  2. A `metric` is defined by what the USER experiences, not by the API that
 *     happens to report it. `largest_content_ms` is "when the primary content
 *     finished appearing"; on the web that is sourced from LCP, on a native
 *     stack from its own first-full-paint signal. Naming the metric `lcp_ms`
 *     would have hard-coded a web API into a contract meant to outlive it.
 *
 * A stack that genuinely cannot supply a metric reports it as absent. Absent is
 * a distinct state from zero and from "good": comparisons refuse to score it.
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
  unit: "ms" | "bytes" | "count" | "score"
  direction: MetricDirection
  /** What the user experiences. Written so a non-web stack can implement it. */
  definition: string
  /** Where each stack sources it. Absent stack = does not supply this metric. */
  sources: Record<string, string>
  /** Absolute quality bands, where the metric has externally-defined ones. */
  thresholds?: { good: number; poor: number }
}

/**
 * The metric vocabulary.
 *
 * Deliberately small. Every entry has to be answerable by any UI stack that
 * draws pixels and responds to input; anything that can only be expressed in
 * one stack's terms belongs in a lane's debug output, not here.
 */
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
  worst_frame_ms: {
    id: "worst_frame_ms",
    unit: "ms",
    direction: "lower",
    definition: "The single longest interval the UI thread was unavailable to draw.",
    sources: { web: "longest renderer task", native: "longest frame interval" },
    thresholds: { good: 16.67, poor: 50 },
  },
  frame_p95_ms: {
    id: "frame_p95_ms",
    unit: "ms",
    direction: "lower",
    definition: "95th percentile UI-thread interval — the texture of the flow rather than its worst moment.",
    sources: { web: "pooled p95 renderer task", native: "p95 frame interval" },
    thresholds: { good: 16.67, poor: 33.34 },
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
