// Percentiles, overhead math, and the row-format vocabulary shared by the
// loadgen and its report writers. The row names deliberately mirror the
// original June Cloudflare-relay evaluation so a re-evaluation report can
// be diffed against the June tables field-for-field.

export type Sample = number

/**
 * Nearest-rank percentile over a copy of the samples. Returns NaN for an empty
 * set so callers can render "n/a" rather than a misleading 0.
 */
export function percentile(samples: readonly Sample[], p: number): number {
  if (samples.length === 0) return Number.NaN
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index]!
}

export function mean(samples: readonly Sample[]): number {
  if (samples.length === 0) return Number.NaN
  return samples.reduce((sum, value) => sum + value, 0) / samples.length
}

export function round2(value: number): number {
  if (!Number.isFinite(value)) return value
  return Math.round(value * 100) / 100
}

/** Overhead = relayed percentile minus the direct percentile (ms). */
export function overheadMs(relayed: readonly Sample[], direct: readonly Sample[], p = 99): number {
  return round2(percentile(relayed, p) - percentile(direct, p))
}

// The June gates, encoded once so both the CLI summary and the JSON artifact
// report the same PASS/FAIL. p99 relay overhead under 100ms; zero relayed-WS
// message loss.
export const HTTP_P99_OVERHEAD_GATE_MS = 100
export const WS_P99_OVERHEAD_GATE_MS = 100

export type DeliveryCounts = {
  attempted: number
  delivered: number
}

export type RowMetrics = {
  rowId: string
  // Shape descriptor, e.g. "c200/load600" (concurrency / total WS messages).
  shape: string
  target: string
  relay: string
  // HTTP p99 overhead vs direct (ms). June column: "HTTP p99 overhead".
  httpP99OverheadMs: number
  // WS-message p99 overhead vs direct (ms). June column: "WS-message p99 overhead".
  wsMessageP99OverheadMs: number
  // Relayed / direct WS message delivery. June column: "relayed WS N/N".
  relayedWsMessages: DeliveryCounts
  directWsMessages: DeliveryCounts
  // Relayed WS connect p95 (ms) — client wall clock from upgrade request to open.
  connectP95Ms: number
  // Upstream-open p95 (ms). Sourced from the relay's relay.trace
  // wsUpstreamOpenMs when available (x-claxedo-relay-ws-trace: 1), else the
  // client connect wall clock. June column: "upstream-open p95".
  upstreamOpenP95Ms: number
  upstreamOpenSource: "relay-trace" | "client-wall-clock"
  // Holder setup: relayed WS connections that reached "open" / attempted.
  // June column: "holder setup N/N".
  holderSetup: DeliveryCounts
  // Upstream failure codes seen on relayed WS setup (HTTP status or WS close
  // code, tallied). June column: "upstream failure codes" (429 / 503 / timeout).
  upstreamFailureCodes: Record<string, number>
  // June DO trace fields, when the trace header was honored.
  trace?: {
    wsUpstreamOpenP95Ms: number
    maxQueuedFrames: number
    maxQueuedDelayMs: number
    samples: number
  }
  gates: {
    httpP99OverheadPass: boolean
    wsMessageP99OverheadPass: boolean
    zeroRelayedWsLossPass: boolean
    pass: boolean
  }
}

export function evaluateGates(row: Omit<RowMetrics, "gates">): RowMetrics["gates"] {
  const httpP99OverheadPass = Number.isFinite(row.httpP99OverheadMs)
    ? row.httpP99OverheadMs < HTTP_P99_OVERHEAD_GATE_MS
    : true
  const wsMessageP99OverheadPass = Number.isFinite(row.wsMessageP99OverheadMs)
    ? row.wsMessageP99OverheadMs < WS_P99_OVERHEAD_GATE_MS
    : true
  const zeroRelayedWsLossPass =
    row.relayedWsMessages.attempted > 0 &&
    row.relayedWsMessages.delivered === row.relayedWsMessages.attempted
  return {
    httpP99OverheadPass,
    wsMessageP99OverheadPass,
    zeroRelayedWsLossPass,
    pass: httpP99OverheadPass && wsMessageP99OverheadPass && zeroRelayedWsLossPass,
  }
}

function ratio(counts: DeliveryCounts): string {
  return `${counts.delivered}/${counts.attempted}`
}

function fmt(value: number): string {
  return Number.isFinite(value) ? `${round2(value)}ms` : "n/a"
}

function codes(input: Record<string, number>): string {
  const entries = Object.entries(input)
  if (entries.length === 0) return "none"
  return entries.map(([code, count]) => `${code}×${count}`).join(" ")
}

/** One markdown table row matching the June evaluation column order. */
export function markdownRow(row: RowMetrics): string {
  return [
    row.rowId,
    row.shape,
    fmt(row.httpP99OverheadMs),
    fmt(row.wsMessageP99OverheadMs),
    ratio(row.relayedWsMessages),
    ratio(row.directWsMessages),
    fmt(row.connectP95Ms),
    `${fmt(row.upstreamOpenP95Ms)} (${row.upstreamOpenSource === "relay-trace" ? "trace" : "wall"})`,
    ratio(row.holderSetup),
    codes(row.upstreamFailureCodes),
    row.gates.pass ? "PASS" : "FAIL",
  ].map((cell) => cell.replaceAll("|", "\\|")).join(" | ")
}

export const MARKDOWN_HEADER = [
  "| Row | Shape | HTTP p99 overhead | WS-msg p99 overhead | relayed WS | direct WS | connect p95 | upstream-open p95 | holder setup | upstream failure codes | verdict |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
].join("\n")
