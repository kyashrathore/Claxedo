/**
 * The span record and its OTLP encoding.
 *
 * Deliberately a plain data type rather than an SDK object: a span is created
 * in one runtime and finished in another process in this system (a request
 * enters the relay, crosses a WebSocket, and is answered by a laptop), so the
 * thing that models it has to survive being a value.
 *
 * The encoding is OTLP/HTTP JSON — the same protocol the engine's exporter
 * speaks (`packages/core/src/observability/otlp.ts`) — so both land in one
 * collector and a trace that spans the app and the agent engine stays whole.
 */

import type { TraceContext } from "./trace-context"

export type AttributeValue = string | number | boolean

/**
 * OTLP span kinds. The numbers are the wire encoding, not an internal choice.
 *
 * `server` is the hop that RECEIVES; `client` is the hop that CALLS. Getting
 * these right is what lets a collector draw the waterfall instead of a flat
 * list — a client span and the server span it caused are the two halves of one
 * network hop.
 */
export const SpanKind = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
} as const
export type SpanKindName = keyof typeof SpanKind

export const SpanStatus = { unset: 0, ok: 1, error: 2 } as const
export type SpanStatusName = keyof typeof SpanStatus

export type SpanEvent = {
  name: string
  timeUnixNano: bigint
  attributes?: Record<string, AttributeValue | undefined>
}

export type FinishedSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: SpanKindName
  startTimeUnixNano: bigint
  endTimeUnixNano: bigint
  attributes: Record<string, AttributeValue | undefined>
  status: SpanStatusName
  statusMessage?: string
  events: SpanEvent[]
}

export type Resource = {
  serviceName: string
  /** Which copy of the service this is — a Worker isolate, a laptop, a browser tab. */
  serviceInstanceId?: string
  attributes?: Record<string, AttributeValue | undefined>
}

/**
 * Epoch nanoseconds.
 *
 * `Date.now()` is milliseconds, and in a Cloudflare Worker it is also FROZEN
 * between I/O operations — every synchronous statement reports the same
 * instant, by design, as a side-channel mitigation. So a span that starts and
 * ends without awaiting anything has a duration of exactly zero there, and
 * that is the platform telling the truth rather than a bug to work around.
 * `performance.now()` supplies sub-millisecond ordering where it is available
 * and monotonic.
 */
const epochOriginMs = Date.now()
const monotonicOriginMs = typeof performance === "object" ? performance.now() : 0

export function nowUnixNano(): bigint {
  if (typeof performance !== "object") return BigInt(Date.now()) * 1_000_000n
  const elapsedMs = performance.now() - monotonicOriginMs
  return BigInt(Math.round((epochOriginMs + elapsedMs) * 1_000_000))
}

function encodeAttributes(attributes: Record<string, AttributeValue | undefined>) {
  return Object.entries(attributes)
    // An absent attribute is omitted, not sent as null: OTLP has no null
    // attribute value, and collectors differ on what they do with one.
    .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined)
    .map(([key, value]) => ({
      key,
      value:
        typeof value === "string"
          ? { stringValue: value }
          : typeof value === "boolean"
            ? { boolValue: value }
            : Number.isInteger(value)
              ? { intValue: String(value) }
              : { doubleValue: value },
    }))
}

/** One OTLP `ResourceSpans` payload carrying every span in the batch. */
export function encodeOtlpSpans(resource: Resource, spans: readonly FinishedSpan[]) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: encodeAttributes({
            "service.name": resource.serviceName,
            ...(resource.serviceInstanceId ? { "service.instance.id": resource.serviceInstanceId } : {}),
            ...resource.attributes,
          }),
        },
        scopeSpans: [
          {
            scope: { name: "@claxedo/telemetry" },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: SpanKind[span.kind],
              // OTLP JSON carries 64-bit values as strings; a number would
              // lose precision above 2^53 and nanosecond timestamps are well
              // past that.
              startTimeUnixNano: span.startTimeUnixNano.toString(),
              endTimeUnixNano: span.endTimeUnixNano.toString(),
              attributes: encodeAttributes(span.attributes),
              status: {
                code: SpanStatus[span.status],
                ...(span.statusMessage ? { message: span.statusMessage } : {}),
              },
              events: span.events.map((event) => ({
                name: event.name,
                timeUnixNano: event.timeUnixNano.toString(),
                attributes: encodeAttributes(event.attributes ?? {}),
              })),
            })),
          },
        ],
      },
    ],
  }
}

/** The context a child hop should carry to be parented to this span. */
export function childContext(span: Pick<FinishedSpan, "traceId" | "spanId">, sampled: boolean): TraceContext {
  return { traceId: span.traceId, spanId: span.spanId, sampled }
}
