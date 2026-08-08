export interface ReportMetrics {
  schemaVersion: 1
  sessionsAnalyzed: number
  executionCalls: number
  justBashPercent: number | null
  fullVmPercent: number | null
  medianTimeBeforeFullMachineMs: number | null
  p95TimeBeforeFullMachineMs: number | null
}

export interface StoredReport extends ReportMetrics {
  id: string
  createdAt: string
}

export class InvalidReportError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidReportError("The report must be a JSON object.")
  }
  return value as Record<string, unknown>
}

function integer(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new InvalidReportError(`${name} must be a non-negative integer no greater than ${maximum}.`)
  }
  return value as number
}

function optionalNumber(value: unknown, name: string, maximum: number): number | null {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new InvalidReportError(`${name} must be null or a finite number between 0 and ${maximum}.`)
  }
  return value
}

export function parseReport(value: unknown): ReportMetrics {
  const input = record(value)
  const allowed = new Set([
    "schemaVersion",
    "sessionsAnalyzed",
    "executionCalls",
    "justBashPercent",
    "fullVmPercent",
    "medianTimeBeforeFullMachineMs",
    "p95TimeBeforeFullMachineMs",
  ])
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key))
  if (unexpected.length > 0) throw new InvalidReportError(`Unexpected report field: ${unexpected[0]}.`)
  if (input.schemaVersion !== 1) throw new InvalidReportError("schemaVersion must be 1.")

  const report: ReportMetrics = {
    schemaVersion: 1,
    sessionsAnalyzed: integer(input.sessionsAnalyzed, "sessionsAnalyzed", 1_000_000_000),
    executionCalls: integer(input.executionCalls, "executionCalls", 1_000_000_000_000),
    justBashPercent: optionalNumber(input.justBashPercent, "justBashPercent", 100),
    fullVmPercent: optionalNumber(input.fullVmPercent, "fullVmPercent", 100),
    medianTimeBeforeFullMachineMs: optionalNumber(
      input.medianTimeBeforeFullMachineMs,
      "medianTimeBeforeFullMachineMs",
      31_536_000_000,
    ),
    p95TimeBeforeFullMachineMs: optionalNumber(
      input.p95TimeBeforeFullMachineMs,
      "p95TimeBeforeFullMachineMs",
      31_536_000_000,
    ),
  }

  const percentages = [report.justBashPercent, report.fullVmPercent]
  if (report.executionCalls === 0) {
    if (percentages.some((item) => item !== null)) {
      throw new InvalidReportError("Runtime percentages must be null when executionCalls is zero.")
    }
  } else {
    if (percentages.some((item) => item === null)) {
      throw new InvalidReportError("Runtime percentages are required when executionCalls is non-zero.")
    }
    const total = percentages.reduce<number>((sum, item) => sum + (item ?? 0), 0)
    if (Math.abs(total - 100) > 0.05) {
      throw new InvalidReportError("Runtime percentages must add up to 100%.")
    }
  }

  if (
    report.medianTimeBeforeFullMachineMs !== null &&
    report.p95TimeBeforeFullMachineMs !== null &&
    report.medianTimeBeforeFullMachineMs > report.p95TimeBeforeFullMachineMs
  ) {
    throw new InvalidReportError("medianTimeBeforeFullMachineMs cannot be greater than p95TimeBeforeFullMachineMs.")
  }
  return report
}

const integerFormatter = new Intl.NumberFormat("en-US")

export function formatInteger(value: number): string {
  return integerFormatter.format(value)
}

export function formatPercent(value: number | null): string {
  return value === null ? "Unavailable" : `${value.toFixed(2)}%`
}

export function formatDuration(value: number | null): string {
  if (value === null) return "Unavailable"
  if (value < 1_000) return `${Math.round(value)}ms`
  return `${(value / 1_000).toFixed(1)}s`
}

export function metricRows(report: ReportMetrics): ReadonlyArray<readonly [string, string]> {
  return [
    ["Sessions analyzed", formatInteger(report.sessionsAnalyzed)],
    ["Execution calls", formatInteger(report.executionCalls)],
    ["Can run in just-bash", formatPercent(report.justBashPercent)],
    ["Full VM required", formatPercent(report.fullVmPercent)],
    ["Median time before agent needs full machine again", formatDuration(report.medianTimeBeforeFullMachineMs)],
    ["p95 time before agent needs full machine again", formatDuration(report.p95TimeBeforeFullMachineMs)],
  ]
}
