import type { Direction, Measurement, MetricSummary } from "./types"

export function percentile(values: number[], rank: number) {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  const index = Math.ceil((rank / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]
}

export function summarize(measurement: Measurement): MetricSummary {
  const mean = measurement.samples.reduce((sum, value) => sum + value, 0) / measurement.samples.length
  const variance = measurement.samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / measurement.samples.length
  return {
    ...measurement,
    value: percentile(measurement.samples, 95),
    p50: percentile(measurement.samples, 50),
    p95: percentile(measurement.samples, 95),
    min: Math.min(...measurement.samples),
    max: Math.max(...measurement.samples),
    mean,
    relative_stddev: mean === 0 ? 0 : Math.sqrt(variance) / mean,
  }
}

export function betterThan(current: number, previous: number, direction: Direction, improvement: number) {
  if (previous === 0) return current === 0
  const delta = direction === "lower" ? previous - current : current - previous
  return (delta / previous) * 100 >= improvement
}

export function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
