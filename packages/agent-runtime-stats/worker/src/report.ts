export interface ReportMetrics {
  schemaVersion: 2
  sessionsAnalyzed: number
  executionCalls: number
  sessionsWithoutFullMachinePercent: number | null
  turnsAnalyzed: number
  turnCoveragePercent: number | null
  turnsWithoutFullMachinePercent: number | null
  repeatFullMachineTurnPercent: number | null
  medianCallsAfterFirstFullMachine: number | null
  medianObservedSpanAfterFirstFullMachineMs: number | null
  p95ObservedSpanAfterFirstFullMachineMs: number | null
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
    "sessionsWithoutFullMachinePercent",
    "turnsAnalyzed",
    "turnCoveragePercent",
    "turnsWithoutFullMachinePercent",
    "repeatFullMachineTurnPercent",
    "medianCallsAfterFirstFullMachine",
    "medianObservedSpanAfterFirstFullMachineMs",
    "p95ObservedSpanAfterFirstFullMachineMs",
  ])
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key))
  if (unexpected.length > 0) throw new InvalidReportError(`Unexpected report field: ${unexpected[0]}.`)
  if (input.schemaVersion !== 2) throw new InvalidReportError("schemaVersion must be 2.")

  const report: ReportMetrics = {
    schemaVersion: 2,
    sessionsAnalyzed: integer(input.sessionsAnalyzed, "sessionsAnalyzed", 1_000_000_000),
    executionCalls: integer(input.executionCalls, "executionCalls", 1_000_000_000_000),
    sessionsWithoutFullMachinePercent: optionalNumber(
      input.sessionsWithoutFullMachinePercent,
      "sessionsWithoutFullMachinePercent",
      100,
    ),
    turnsAnalyzed: integer(input.turnsAnalyzed, "turnsAnalyzed", 1_000_000_000_000),
    turnCoveragePercent: optionalNumber(input.turnCoveragePercent, "turnCoveragePercent", 100),
    turnsWithoutFullMachinePercent: optionalNumber(
      input.turnsWithoutFullMachinePercent,
      "turnsWithoutFullMachinePercent",
      100,
    ),
    repeatFullMachineTurnPercent: optionalNumber(
      input.repeatFullMachineTurnPercent,
      "repeatFullMachineTurnPercent",
      100,
    ),
    medianCallsAfterFirstFullMachine: optionalNumber(
      input.medianCallsAfterFirstFullMachine,
      "medianCallsAfterFirstFullMachine",
      1_000_000_000_000,
    ),
    medianObservedSpanAfterFirstFullMachineMs: optionalNumber(
      input.medianObservedSpanAfterFirstFullMachineMs,
      "medianObservedSpanAfterFirstFullMachineMs",
      31_536_000_000,
    ),
    p95ObservedSpanAfterFirstFullMachineMs: optionalNumber(
      input.p95ObservedSpanAfterFirstFullMachineMs,
      "p95ObservedSpanAfterFirstFullMachineMs",
      31_536_000_000,
    ),
  }

  if (report.sessionsAnalyzed === 0 && report.sessionsWithoutFullMachinePercent !== null) {
    throw new InvalidReportError("sessionsWithoutFullMachinePercent must be null when sessionsAnalyzed is zero.")
  }
  if (report.executionCalls === 0 && report.turnCoveragePercent !== null) {
    throw new InvalidReportError("turnCoveragePercent must be null when executionCalls is zero.")
  }
  if (report.turnsAnalyzed === 0 && report.turnsWithoutFullMachinePercent !== null) {
    throw new InvalidReportError("turnsWithoutFullMachinePercent must be null when turnsAnalyzed is zero.")
  }
  if (
    report.medianObservedSpanAfterFirstFullMachineMs !== null &&
    report.p95ObservedSpanAfterFirstFullMachineMs !== null &&
    report.medianObservedSpanAfterFirstFullMachineMs > report.p95ObservedSpanAfterFirstFullMachineMs
  ) {
    throw new InvalidReportError(
      "medianObservedSpanAfterFirstFullMachineMs cannot be greater than p95ObservedSpanAfterFirstFullMachineMs.",
    )
  }
  return report
}

const integerFormatter = new Intl.NumberFormat("en-US")

export function formatInteger(value: number): string {
  return integerFormatter.format(value)
}

export function formatNumber(value: number | null): string {
  return value === null ? "Unavailable" : value.toFixed(1).replace(/\.0$/, "")
}

export function formatPercent(value: number | null): string {
  return value === null ? "Unavailable" : `${value.toFixed(2)}%`
}

export function formatDuration(value: number | null): string {
  if (value === null) return "Unavailable"
  if (value < 1_000) return `${Math.round(value)}ms`
  return `${(value / 1_000).toFixed(1)}s`
}

export function headlineMetricRows(report: ReportMetrics): ReadonlyArray<readonly [string, string]> {
  return [
    ["Sessions analyzed", formatInteger(report.sessionsAnalyzed)],
    ["Execution calls", formatInteger(report.executionCalls)],
    ["Sessions completed without full machine", formatPercent(report.sessionsWithoutFullMachinePercent)],
  ]
}

export function detailMetricRows(report: ReportMetrics): ReadonlyArray<readonly [string, string]> {
  return [
    ["Turns analyzed", formatInteger(report.turnsAnalyzed)],
    ["Execution-call turn coverage", formatPercent(report.turnCoveragePercent)],
    ["Turns completed without full machine", formatPercent(report.turnsWithoutFullMachinePercent)],
    ["Full-machine turns needing it again", formatPercent(report.repeatFullMachineTurnPercent)],
    ["Median calls after first full-machine need", formatNumber(report.medianCallsAfterFirstFullMachine)],
    [
      "Median observed span after first full-machine need",
      formatDuration(report.medianObservedSpanAfterFirstFullMachineMs),
    ],
    ["p95 observed span after first full-machine need", formatDuration(report.p95ObservedSpanAfterFirstFullMachineMs)],
  ]
}

export function metricRows(report: ReportMetrics): ReadonlyArray<readonly [string, string]> {
  return [...headlineMetricRows(report), ...detailMetricRows(report)]
}
