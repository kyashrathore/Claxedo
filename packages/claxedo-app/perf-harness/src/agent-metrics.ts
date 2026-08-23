export const PRIMARY_AGENT_APP_METRICS = [
  "app.cold_ready_ms",
  "work_item.cold_open_ms",
  "work_item.warm_switch_p95_ms",
  "stream.interaction_p95_ms",
  "stream.blocked_frame_ratio_pct",
  "terminal.input_to_paint_p95_ms",
  "terminal.output_mib_s",
  "resource.peak_process_family_rss_mib",
  "resource.quiescent_cpu_p95_pct",
] as const

export type PrimaryAgentAppMetric = typeof PRIMARY_AGENT_APP_METRICS[number]

export type ExactMetric = {
  state: "exact"
  value: number
  unit: string
}

export type BoundedMetric = {
  state: "bounded"
  upperBound: number
  unit: string
  reason: string
}

export type UnsupportedMetric = {
  state: "unsupported"
  reason: string
}

export type InvalidMetric = {
  state: "invalid"
  reason: string
}

export type AgentMetricValue = ExactMetric | BoundedMetric | UnsupportedMetric | InvalidMetric

export function eventTimingP95(input: {
  probeCount: number
  durationThresholdMs: number
  entries: Array<{ interactionId: number; durationMs: number }>
}): AgentMetricValue {
  if (!Number.isInteger(input.probeCount) || input.probeCount <= 0) return invalid("invalid-probe-count")
  if (!finitePositive(input.durationThresholdMs)) return invalid("invalid-duration-threshold")
  if (input.entries.length > input.probeCount) return invalid("too-many-event-entries")

  const interactionIds = new Set<number>()
  for (const entry of input.entries) {
    if (!Number.isInteger(entry.interactionId) || entry.interactionId <= 0) {
      return invalid("unmatched-interaction-id")
    }
    if (interactionIds.has(entry.interactionId)) return invalid("duplicate-interaction-id")
    if (!Number.isFinite(entry.durationMs) || entry.durationMs < input.durationThresholdMs) {
      return invalid("invalid-event-duration")
    }
    interactionIds.add(entry.interactionId)
  }

  const censoredCount = input.probeCount - input.entries.length
  const rank = Math.ceil(input.probeCount * 0.95)
  if (rank <= censoredCount) {
    return {
      state: "bounded",
      upperBound: input.durationThresholdMs,
      unit: "ms",
      reason: "below-event-timing-threshold",
    }
  }
  const observed = input.entries.map((entry) => entry.durationMs).toSorted((a, b) => a - b)
  const value = observed[rank - censoredCount - 1]
  return value === undefined ? invalid("missing-event-order-statistic") : exact(value, "ms")
}

export function blockedFrameRatio(input: {
  scenarioDurationMs: number
  supported: boolean
  entries: Array<{ durationMs: number; blockingDurationMs: number }>
}): AgentMetricValue {
  if (!input.supported) return { state: "unsupported", reason: "long-animation-frame-unavailable" }
  if (!finitePositive(input.scenarioDurationMs)) return invalid("invalid-scenario-duration")
  if (input.entries.some((entry) =>
    !Number.isFinite(entry.durationMs) ||
    !Number.isFinite(entry.blockingDurationMs) ||
    entry.durationMs < 0 ||
    entry.blockingDurationMs < 0 ||
    entry.blockingDurationMs > entry.durationMs)) {
    return invalid("invalid-long-animation-frame")
  }
  const blockedMs = input.entries.reduce((total, entry) => total + entry.blockingDurationMs, 0)
  return exact(round((blockedMs / input.scenarioDurationMs) * 100), "percent")
}

export function terminalThroughput(input: {
  bytes: number
  startedAtMs: number
  paintedAtMs: number
  exactModelHash: boolean
  concurrentInputP95Ms: number
  minimumDurationMs: number
}): AgentMetricValue {
  if (!input.exactModelHash) return invalid("terminal-model-mismatch")
  if (!Number.isFinite(input.concurrentInputP95Ms) || input.concurrentInputP95Ms > 100) {
    return invalid("terminal-input-unresponsive")
  }
  const durationMs = input.paintedAtMs - input.startedAtMs
  if (!finitePositive(input.minimumDurationMs) || durationMs < input.minimumDurationMs) {
    return invalid("terminal-duration-too-short")
  }
  if (!Number.isInteger(input.bytes) || input.bytes <= 0 || !finitePositive(durationMs)) {
    return invalid("invalid-terminal-throughput-evidence")
  }
  return exact(round(input.bytes / 1024 / 1024 / (durationMs / 1_000)), "MiB/s")
}

export function resourceMetrics(input: {
  samples: Array<{ atMs: number; rssBytes: number; cpuPercent: number }>
  requestedIntervalMs: number
  expectedDurationMs: number
}): {
  peakRss: AgentMetricValue
  cpuP95: AgentMetricValue
  achievedSamples: number
  expectedSamples: number
} {
  const expectedSamples = finitePositive(input.requestedIntervalMs) && input.expectedDurationMs >= 0
    ? Math.floor(input.expectedDurationMs / input.requestedIntervalMs) + 1
    : 0
  const result = (value: AgentMetricValue) => ({
    peakRss: value,
    cpuP95: value,
    achievedSamples: input.samples.length,
    expectedSamples,
  })
  if (expectedSamples === 0) return result(invalid("invalid-resource-window"))

  const ordered = input.samples.toSorted((a, b) => a.atMs - b.atMs)
  for (let index = 0; index < ordered.length; index++) {
    const sample = ordered[index]!
    if (
      !Number.isFinite(sample.atMs) ||
      !Number.isFinite(sample.rssBytes) || sample.rssBytes < 0 ||
      !Number.isFinite(sample.cpuPercent) || sample.cpuPercent < 0
    ) return result(invalid("invalid-resource-sample"))
    const previous = ordered[index - 1]
    if (previous && sample.atMs - previous.atMs > input.requestedIntervalMs * 2) {
      return result(invalid("resource-sample-gap"))
    }
  }
  if (input.samples.length < Math.ceil(expectedSamples * 0.95)) {
    return result(invalid("insufficient-resource-samples"))
  }

  const peakRssBytes = Math.max(...ordered.map((sample) => sample.rssBytes))
  return {
    peakRss: exact(round(peakRssBytes / 1024 / 1024), "MiB"),
    cpuP95: exact(round(percentile(ordered.map((sample) => sample.cpuPercent), 95)), "percent"),
    achievedSamples: input.samples.length,
    expectedSamples,
  }
}

export function percentile(values: number[], rank: number) {
  if (values.length === 0 || !Number.isFinite(rank) || rank < 0 || rank > 100) return Number.NaN
  const sorted = values.toSorted((a, b) => a - b)
  const index = Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1)
  return sorted[Math.min(index, sorted.length - 1)]!
}

function exact(value: number, unit: string): ExactMetric {
  return { state: "exact", value, unit }
}

function invalid(reason: string): InvalidMetric {
  return { state: "invalid", reason }
}

function finitePositive(value: number) {
  return Number.isFinite(value) && value > 0
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000
}
