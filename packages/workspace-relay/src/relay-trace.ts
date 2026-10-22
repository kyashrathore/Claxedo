import { trimToUndefined } from "@claxedo/helpers/string"

export const TRACE_ID_HEADER = "x-claxedo-trace-id"
const TRACE_FORCE_HEADER = "x-claxedo-relay-trace"
/**
 * Set by a room on a sampled trace's response and consumed by the gateway: the
 * gateway appends its own phases only behind this marker, never behind an
 * upstream's `server-timing`, which a session host answers on every response.
 */
export const TRACE_SAMPLED_RESPONSE_HEADER = "x-claxedo-relay-sampled"

export type WorkspaceRelayTraceLogEvent = {
  event: "workspace_relay_request"
  traceId: string
  workspaceId?: string
  routeKind: string
  method: string
  path: string
  status: number
  totalMs: number
  phases: Record<string, number>
}

export type RelayTraceSampling = {
  traceSampleRate?: number
  traceForceHeaderSecret?: string
  random?: () => number
}

export type RelayTrace = {
  id: string
  sampled: boolean
  startedAt: number
  routeKind: string
  phases: Array<{ name: string; ms: number }>
}

function clampRate(input: number | undefined) {
  if (input === undefined || !Number.isFinite(input)) return 0
  if (input <= 0) return 0
  if (input >= 1) return 1
  return input
}

export function traceRequest(request: Request, routeKind: string, options: RelayTraceSampling): RelayTrace {
  const id = trimToUndefined(request.headers.get(TRACE_ID_HEADER)) ?? crypto.randomUUID()
  const forceSecret = trimToUndefined(options.traceForceHeaderSecret)
  const forced = !!forceSecret && request.headers.get(TRACE_FORCE_HEADER) === forceSecret
  const rate = clampRate(options.traceSampleRate)
  return {
    id,
    sampled: forced || (rate > 0 && (options.random ?? Math.random)() < rate),
    startedAt: performance.now(),
    routeKind,
    phases: [],
  }
}

export async function traceSpan<T>(trace: RelayTrace | undefined, name: string, fn: () => Promise<T>) {
  const startedAt = performance.now()
  try {
    return await fn()
  } finally {
    trace?.phases.push({ name, ms: performance.now() - startedAt })
  }
}

export function tracedRequest(request: Request, trace: RelayTrace, forwarded: { url: string; headers: Headers } = request) {
  const headers = new Headers(forwarded.headers)
  headers.set(TRACE_ID_HEADER, trace.id)
  // Set-or-strip, never passthrough: the sampled marker must reflect this
  // relay's own sampling decision, not a client-supplied header.
  if (trace.sampled) headers.set("x-claxedo-trace-sampled", "1")
  else headers.delete("x-claxedo-trace-sampled")
  return new Request(forwarded.url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: request.redirect,
    duplex: "half",
  } as RequestInit)
}

function roundedMs(value: number) {
  return Math.round(value * 100) / 100
}

export function serverTiming(phases: ReadonlyArray<{ name: string; ms: number }>) {
  return phases
    .map((phase) => `${phase.name};dur=${roundedMs(phase.ms)}`)
    .join(", ")
}

/** The `relay.trace` frame a client that opted in with `x-claxedo-relay-ws-trace` receives once the upstream opens. */
export function webSocketTraceFrame(upstreamStartedAt: number, queueTimes: readonly number[], openedAt: number) {
  return {
    type: "relay.trace",
    wsUpstreamOpenMs: roundedMs(openedAt - upstreamStartedAt),
    queuedFrames: queueTimes.length,
    maxQueuedDelayMs: roundedMs(queueTimes.reduce((max, at) => Math.max(max, openedAt - at), 0)),
  }
}

export function withTraceHeaders(response: Response, trace: RelayTrace) {
  const headers = new Headers(response.headers)
  headers.set(TRACE_ID_HEADER, trace.id)
  // Phase timings expose internal routing/upstream latency breakdowns, so they
  // are only emitted for sampled traces — never on every production response.
  const timing = trace.sampled ? serverTiming(trace.phases) : ""
  if (timing) {
    const existing = headers.get("server-timing")
    headers.set("server-timing", existing ? `${existing}, ${timing}` : timing)
    headers.set(TRACE_SAMPLED_RESPONSE_HEADER, "1")
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function logTrace(
  options: { traceLog?: (event: WorkspaceRelayTraceLogEvent) => void },
  request: Request,
  workspaceId: string | undefined,
  trace: RelayTrace,
  response: Response,
) {
  if (!trace.sampled) return
  const url = new URL(request.url)
  const totalMs = performance.now() - trace.startedAt
  const event: WorkspaceRelayTraceLogEvent = {
    event: "workspace_relay_request",
    traceId: trace.id,
    workspaceId,
    routeKind: trace.routeKind,
    method: request.method,
    path: url.pathname,
    status: response.status,
    totalMs: roundedMs(totalMs),
    phases: Object.fromEntries(trace.phases.map((phase) => [phase.name, roundedMs(phase.ms)])),
  }
  if (options.traceLog) {
    options.traceLog(event)
    return
  }
  console.log(JSON.stringify(event))
}
