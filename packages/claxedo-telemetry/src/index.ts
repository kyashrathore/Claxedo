/**
 * Distributed tracing for the remote-access chain: browser → control plane →
 * relay → Durable Object → host tunnel → laptop daemon → workspace runtime.
 *
 * Exists because that chain has no single vantage point. Its failures have
 * repeatedly been invisible from every individual log: a browser CORS gate
 * drops a request before any server sees it; a relay refuses a host tunnel at
 * the edge so the Durable Object records nothing; a laptop answers a request
 * the app never managed to send. Each one looked, from every log available,
 * like a healthy system.
 *
 * The contract is one string — a W3C `traceparent` — carried across every hop
 * including the non-HTTP one, and OTLP spans emitted to the collector the
 * engine already uses. Turning it on is an endpoint; leaving it off costs
 * nothing.
 */

export {
  continueTrace,
  formatTraceParent,
  newSpanId,
  newTraceId,
  parseTraceParent,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  traceContextFromHeaders,
  traceContextHeaders,
  type TraceContext,
} from "./trace-context"

export {
  childContext,
  encodeOtlpSpans,
  nowUnixNano,
  SpanKind,
  SpanStatus,
  type AttributeValue,
  type FinishedSpan,
  type Resource,
  type SpanEvent,
  type SpanKindName,
  type SpanStatusName,
} from "./span"

export { createTracer, withSpan, type Span, type SpanSink, type Tracer, type TracerOptions } from "./tracer"

export { createOtlpExporter, otlpConfigFromEnv, type ExporterOptions, type SpanExporter } from "./exporter"
