/**
 * W3C Trace Context — the only thing every hop in this system agrees on.
 *
 * The chain crosses four runtimes (browser, Cloudflare Worker, Durable Object,
 * Node) and one non-HTTP transport (the host tunnel's WebSocket frames). No
 * OpenTelemetry SDK spans all of those: the engine's SDK
 * (`packages/core/src/observability/otlp.ts`) is Effect + Node + AsyncLocalStorage,
 * which does not exist in a Worker or a browser. What DOES travel everywhere is
 * this: a 55-character string.
 *
 * So propagation is implemented here from the spec rather than imported, and
 * emission (`span.ts`) speaks OTLP so the spans land in the same collector as
 * the engine's. A trace that starts in the browser and ends in a workspace
 * runtime is one trace, not four.
 *
 * Spec: https://www.w3.org/TR/trace-context/
 */

/** The header every hop reads and writes. Lowercase — HTTP header names are case-insensitive but Workers normalize. */
export const TRACEPARENT_HEADER = "traceparent"
export const TRACESTATE_HEADER = "tracestate"

/** Sampled flag, bit 0 of trace-flags. The only flag the spec defines today. */
const FLAG_SAMPLED = 0x01

/** The only version this implementation emits. Higher versions are parsed leniently, per spec. */
const VERSION = "00"

const INVALID_TRACE_ID = "0".repeat(32)
const INVALID_SPAN_ID = "0".repeat(16)

export type TraceContext = {
  /** 32 lowercase hex characters, never all zero. */
  traceId: string
  /** 16 lowercase hex characters, never all zero — the CALLER's span, which becomes our parent. */
  spanId: string
  /** Whether this trace is being recorded. An unsampled context still propagates. */
  sampled: boolean
  /** Vendor state, passed through untouched. */
  traceState?: string
}

function hex(bytes: number) {
  const values = new Uint8Array(bytes)
  crypto.getRandomValues(values)
  let out = ""
  for (const value of values) out += value.toString(16).padStart(2, "0")
  return out
}

export function newTraceId() {
  // Vanishingly unlikely, but an all-zero id is INVALID rather than merely
  // unlucky, and a trace that carries one is dropped by every collector.
  let id = hex(16)
  while (id === INVALID_TRACE_ID) id = hex(16)
  return id
}

export function newSpanId() {
  let id = hex(8)
  while (id === INVALID_SPAN_ID) id = hex(8)
  return id
}

function isHex(value: string, length: number) {
  if (value.length !== length) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const digit = code >= 48 && code <= 57
    const lower = code >= 97 && code <= 102
    if (!digit && !lower) return false
  }
  return true
}

/**
 * Parse a `traceparent`, returning undefined for anything malformed.
 *
 * Rejecting is the correct response to a bad value: the spec says a receiver
 * that cannot parse the header MUST behave as though it were absent and start
 * a new trace, rather than guess. Accepting a partially-valid header is how a
 * broken caller silently poisons every trace downstream of it.
 */
export function parseTraceParent(value: string | null | undefined, traceState?: string | null): TraceContext | undefined {
  if (!value) return undefined
  const parts = value.trim().split("-")
  // A future version may append fields; the first four keep their meaning.
  if (parts.length < 4) return undefined
  const [version, traceId, spanId, flags] = parts as [string, string, string, string]
  if (!isHex(version, 2) || version === "ff") return undefined
  // Version 00 is exactly four fields. Extra fields there are a malformed
  // header, not a forward-compatible one.
  if (version === VERSION && parts.length !== 4) return undefined
  if (!isHex(traceId, 32) || traceId === INVALID_TRACE_ID) return undefined
  if (!isHex(spanId, 16) || spanId === INVALID_SPAN_ID) return undefined
  if (!isHex(flags, 2)) return undefined
  return {
    traceId,
    spanId,
    sampled: (Number.parseInt(flags, 16) & FLAG_SAMPLED) === FLAG_SAMPLED,
    ...(traceState ? { traceState } : {}),
  }
}

/** Serialize a context for the wire. */
export function formatTraceParent(context: Pick<TraceContext, "traceId" | "spanId" | "sampled">) {
  return `${VERSION}-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`
}

/** Read the context a caller sent, from anything header-shaped. */
export function traceContextFromHeaders(
  headers: Headers | Record<string, string | undefined> | undefined,
): TraceContext | undefined {
  if (!headers) return undefined
  const read = (name: string) => {
    if (headers instanceof Headers) return headers.get(name)
    // Header maps reach this from the tunnel's frames, where casing is
    // whatever the original sender used.
    const direct = headers[name]
    if (direct !== undefined) return direct
    const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
    return match?.[1]
  }
  return parseTraceParent(read(TRACEPARENT_HEADER), read(TRACESTATE_HEADER))
}

/** The headers a caller must send to continue this trace in the next hop. */
export function traceContextHeaders(context: TraceContext): Record<string, string> {
  return {
    [TRACEPARENT_HEADER]: formatTraceParent(context),
    ...(context.traceState ? { [TRACESTATE_HEADER]: context.traceState } : {}),
  }
}

/**
 * Continue the caller's trace, or start one.
 *
 * The returned context names the span the NEXT hop should parent to, so the
 * caller stamps this on outbound requests after starting its own span.
 */
export function continueTrace(incoming: TraceContext | undefined, sampled: boolean): TraceContext {
  if (incoming) return { ...incoming, spanId: newSpanId() }
  return { traceId: newTraceId(), spanId: newSpanId(), sampled }
}
