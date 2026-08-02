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
//
// These are the RUNBOOK numbers and the default everywhere. The env overrides
// below exist for ONE case: a shared CI runner, whose scheduling jitter is not a
// property of the relay. Overriding is a deliberate, commented act in the
// workflow file — never a way to make a red local gate go green. Loss gates have
// no override at all, because "zero" does not degrade with runner noise.
//
// Measured headroom at the default `c20/load20` shape across six local runs
// (2026-07-17 and 2026-07-30): HTTP p99 overhead 7.58–9.96 ms, WS-message p99
// overhead 1.73–2.18 ms. So WS sits ~46x under its gate and HTTP only ~10x —
// which is why the CI workflow raises the HTTP number and leaves WS alone.
function gateFromEnv(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  // A malformed override must not silently disable a gate: an unparseable or
  // non-positive value is a configuration bug, and inheriting the strict
  // default is the safe reading of it.
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

export const HTTP_P99_OVERHEAD_GATE_MS = gateFromEnv("CLAXEDO_BENCH_HTTP_P99_GATE_MS", 100)
export const WS_P99_OVERHEAD_GATE_MS = gateFromEnv("CLAXEDO_BENCH_WS_P99_GATE_MS", 100)

/**
 * The canonical shape label: `c<concurrency>/load<connections>/m<msgsPerConn>`.
 *
 * The old format was `c<n>/load<n>`, which printed the connection count twice
 * and the message count not at all — so `c20/load20` labelled BOTH an 80-message
 * smoke row (WS p99 ~2 ms) and a 40,000-message stress row (WS p99 66–81 ms,
 * only ~1.3x under the 100 ms gate). Two runs ~500x apart in message volume were
 * indistinguishable in `bench/reports/`, which is how a latency gate ends up
 * tuned against the wrong baseline.
 *
 * The `m<N>` suffix is the loadgen CLI's own fix for this, landed concurrently;
 * this helper exists so the four OTHER composition sites
 * (`local-dry-run.ts`, `cf-dev-smoke.ts`, `multitunnel-run.ts`, and the CLI
 * default) all emit that one format instead of three hand-rolled variants.
 * `multitunnel-run.ts` previously used a fifth (`c<conns>x<msgs>`).
 *
 * Nothing parses this string — it is written to the report and printed, never
 * read back (verified across the repo) — so this is label-only: existing reports
 * stay exactly as they were written, and only NEW rows carry the suffix.
 */
export function shapeLabel(input: {
  concurrency: number
  wsMessagesPerConnection: number
  connections?: number
}): string {
  // `connections` defaults to concurrency: the benches drive them equal unless
  // told otherwise, and `load` is the connection count in the CLI's format.
  const connections = input.connections ?? input.concurrency
  return `c${input.concurrency}/load${connections}/m${input.wsMessagesPerConnection}`
}

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
  // The close reasons behind those codes, tallied. The code says a connection
  // died; the reason names the guard that killed it.
  upstreamFailureReasons?: Record<string, number>
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
    // True when the latency figures describe the run that was asked for. A run
    // whose connections died mid-flight still yields percentiles — over the
    // survivors — and those are not a measurement of anything.
    latencyMeasurable: boolean
    pass: boolean
  }
}

/**
 * A latency percentile is only meaningful when the traffic it summarizes
 * actually happened. `dialin-100k-msgs` (2026-07-17) reported a p99 overhead of
 * **-8972ms** — relayed minus direct, so a negative value claims the relayed
 * path beat a direct connection by nine seconds. It was computing over 22
 * surviving messages out of 100,000 after all 50 connections closed.
 *
 * Treat that as UNMEASURABLE rather than as a number. The old code did the
 * opposite twice over: a non-finite overhead counted as a PASS, and a finite
 * but impossible one was compared against the gate as if it were real.
 */
function latencyIsMeasurable(row: Omit<RowMetrics, "gates">): boolean {
  const { attempted, delivered } = row.relayedWsMessages
  if (attempted === 0) return false
  // Percentiles over a small surviving fraction describe the survivors, not the
  // run. 99% is deliberately permissive: it admits ordinary jitter and rejects
  // the collapse case this exists for.
  if (delivered < attempted * 0.99) return false
  // Overhead is relayed − direct. Negative means the relayed path outran a
  // direct connection, which is not physically possible over the same network.
  if (Number.isFinite(row.wsMessageP99OverheadMs) && row.wsMessageP99OverheadMs < 0) return false
  return true
}

export function evaluateGates(row: Omit<RowMetrics, "gates">): RowMetrics["gates"] {
  const latencyMeasurable = latencyIsMeasurable(row)
  const httpP99OverheadPass = Number.isFinite(row.httpP99OverheadMs)
    ? row.httpP99OverheadMs < HTTP_P99_OVERHEAD_GATE_MS
    : true
  // An unmeasurable latency can never PASS. It previously could, twice: a
  // non-finite value short-circuited to `true`, and a nonsense negative value
  // sailed under the gate because it compared as "less than 100ms".
  const wsMessageP99OverheadPass = !latencyMeasurable
    ? false
    : Number.isFinite(row.wsMessageP99OverheadMs)
      ? row.wsMessageP99OverheadMs < WS_P99_OVERHEAD_GATE_MS
      : true
  const zeroRelayedWsLossPass =
    row.relayedWsMessages.attempted > 0 &&
    row.relayedWsMessages.delivered === row.relayedWsMessages.attempted
  return {
    httpP99OverheadPass,
    wsMessageP99OverheadPass,
    zeroRelayedWsLossPass,
    latencyMeasurable,
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
  const reasons = row.upstreamFailureReasons ?? {}
  return [
    row.rowId,
    row.shape,
    fmt(row.httpP99OverheadMs),
    // Print the diagnosis rather than a number nobody can act on. A reader who
    // sees "-8972ms" reasons about latency; one who sees "unmeasurable" goes
    // looking for why the connections died.
    row.gates.latencyMeasurable ? fmt(row.wsMessageP99OverheadMs) : "unmeasurable",
    ratio(row.relayedWsMessages),
    ratio(row.directWsMessages),
    fmt(row.connectP95Ms),
    `${fmt(row.upstreamOpenP95Ms)} (${row.upstreamOpenSource === "relay-trace" ? "trace" : "wall"})`,
    ratio(row.holderSetup),
    codes(row.upstreamFailureCodes),
    // The reason column is what turns "1011×50" into an actionable finding.
    Object.keys(reasons).length === 0 ? "none" : codes(reasons),
    row.gates.pass ? "PASS" : "FAIL",
  ].map((cell) => cell.replaceAll("|", "\\|")).join(" | ")
}

export const MARKDOWN_HEADER = [
  "| Row | Shape | HTTP p99 overhead | WS-msg p99 overhead | relayed WS | direct WS | connect p95 | upstream-open p95 | holder setup | upstream failure codes | close reasons | verdict |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
].join("\n")
