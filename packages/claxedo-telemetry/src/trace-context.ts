/**
 * W3C Trace Context — the only thing every hop in this system agrees on.
 *
 * The chain crosses four runtimes (browser, Cloudflare Worker, Durable Object,
 * Node) and one non-HTTP transport (the host tunnel's WebSocket frames). No
 * OpenTelemetry SDK spans all of those: the Node SDK leans on
 * AsyncLocalStorage, which does not exist in a Worker or a browser. What DOES
 * travel everywhere is
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

/**
 * `tracestate` bounds from the spec: at most 32 members, the whole header at
 * most 512 characters. A member is `key=value` — a lowercase vendor key
 * (optionally `tenant@system`), and a printable-ASCII value with no `,` or
 * `=`. Anything outside the grammar is a broken sender; its members are
 * dropped rather than reflected into the headers this hop sends next, where
 * control characters would be a header-injection vector.
 */
const MAX_TRACESTATE_MEMBERS = 32
const MAX_TRACESTATE_LENGTH = 512
const TRACESTATE_MEMBER = /^[a-z0-9][a-z0-9_\-*/]{0,240}(?:@[a-z0-9][a-z0-9_\-*/]{0,13})?=[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,256}$/

export type TraceContext = {
  /** 32 lowercase hex characters, never all zero. */
  traceId: string
  /** 16 lowercase hex characters, never all zero — the CALLER's span, which becomes our parent. */
  spanId: string
  /** Whether this trace is being recorded. An unsampled context still propagates. */
  sampled: boolean
  /** Vendor state — validated members only; a malformed member never reaches an outbound header. */
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

function isHex(value: string | undefined, length: number): value is string {
  if (value?.length !== length) return false
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
/**
 * Keep the spec-legal members of a `tracestate`, the first occurrence of each
 * key winning, bounded to 32 members and 512 characters of output.
 *
 * Runs at both boundaries: parsing an inbound header (a broken sender's state
 * is dropped before it can ride along) and serializing an outbound one (a
 * hand-built context gets the same scrutiny — the value lands verbatim in a
 * header, so an unvetted string is an injection vector).
 */
export function sanitizeTraceState(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const seen = new Set<string>()
  const members: string[] = []
  let length = 0
  for (const raw of value.split(",")) {
    const member = raw.trim()
    if (!TRACESTATE_MEMBER.test(member)) continue
    const key = member.slice(0, member.indexOf("="))
    if (seen.has(key)) continue
    const cost = member.length + (members.length ? 1 : 0)
    if (members.length >= MAX_TRACESTATE_MEMBERS || length + cost > MAX_TRACESTATE_LENGTH) break
    seen.add(key)
    members.push(member)
    length += cost
  }
  return members.length ? members.join(",") : undefined
}

export function parseTraceParent(value: string | null | undefined, traceState?: string | null): TraceContext | undefined {
  if (!value) return undefined
  const parts = value.trim().split("-")
  // A future version may append fields; the first four keep their meaning.
  if (parts.length < 4) return undefined
  const [version, traceId, spanId, flags] = parts
  if (!isHex(version, 2) || version === "ff") return undefined
  // Version 00 is exactly four fields. Extra fields there are a malformed
  // header, not a forward-compatible one.
  if (version === VERSION && parts.length !== 4) return undefined
  if (!isHex(traceId, 32) || traceId === INVALID_TRACE_ID) return undefined
  if (!isHex(spanId, 16) || spanId === INVALID_SPAN_ID) return undefined
  if (!isHex(flags, 2)) return undefined
  const state = sanitizeTraceState(traceState)
  return {
    traceId,
    spanId,
    sampled: (Number.parseInt(flags, 16) & FLAG_SAMPLED) === FLAG_SAMPLED,
    ...(state ? { traceState: state } : {}),
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
  const traceState = sanitizeTraceState(context.traceState)
  return {
    [TRACEPARENT_HEADER]: formatTraceParent(context),
    ...(traceState ? { [TRACESTATE_HEADER]: traceState } : {}),
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
