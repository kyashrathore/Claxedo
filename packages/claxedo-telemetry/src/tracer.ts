/**
 * The tracer: start a span, finish it, hand its context to the next hop.
 *
 * Context is EXPLICIT — a span is a value you pass, never ambient state you
 * read. That is not a style preference. Cloudflare Workers have no
 * `AsyncLocalStorage` in the shape the OpenTelemetry Node SDK needs, a Durable
 * Object serves many requests from one isolate, and the host tunnel hands a
 * request to a completely different process. Ambient context is wrong or
 * unavailable at three of the four hops, and an implicit parent that is
 * silently wrong produces a trace that LOOKS complete — the failure this whole
 * exercise exists to stop.
 *
 * Costs nothing when unconfigured: with no exporter, `startSpan` returns a
 * span that records nothing and `end` does no work, so instrumentation can sit
 * on hot paths permanently.
 */

import {
  childContext,
  nowUnixNano,
  type AttributeValue,
  type FinishedSpan,
  type SpanKindName,
  type SpanStatusName,
} from "./span"
import { continueTrace, formatTraceParent, TRACEPARENT_HEADER, TRACESTATE_HEADER, type TraceContext } from "./trace-context"

export type SpanSink = (span: FinishedSpan) => void

export type Span = {
  readonly context: TraceContext
  /** Record a fact about this operation. Later writes win. */
  setAttributes: (attributes: Record<string, AttributeValue | undefined>) => void
  /** Mark a moment inside the span — a retry, a queue exit, a cache miss. */
  addEvent: (name: string, attributes?: Record<string, AttributeValue | undefined>) => void
  /** Anything other than `ok` on a completed span shows as a failed hop. */
  setStatus: (status: SpanStatusName, message?: string) => void
  /** The headers the next hop must receive to be parented to this span. */
  headers: () => Record<string, string>
  end: () => void
}

export type Tracer = {
  /**
   * Begin a span.
   *
   * `parent` is the context this hop RECEIVED. Absent, a new trace starts —
   * which is correct for the browser (where traces begin) and a signal worth
   * looking at anywhere else, because it means propagation was dropped
   * upstream.
   */
  startSpan: (
    name: string,
    options?: {
      kind?: SpanKindName
      parent?: TraceContext | undefined
      attributes?: Record<string, AttributeValue | undefined>
    },
  ) => Span
}

/** A span that records nothing, for when no exporter is configured. */
function inertSpan(context: TraceContext): Span {
  return {
    context,
    setAttributes: () => {},
    addEvent: () => {},
    setStatus: () => {},
    // Propagation continues even unsampled: a downstream hop that IS sampled
    // must still join this trace rather than start its own.
    headers: () => ({
      [TRACEPARENT_HEADER]: formatTraceParent(context),
      ...(context.traceState ? { [TRACESTATE_HEADER]: context.traceState } : {}),
    }),
    end: () => {},
  }
}

export type TracerOptions = {
  /** Where finished spans go. Omit to disable recording entirely. */
  sink?: SpanSink | undefined
  /**
   * Whether to record a trace that arrives with no parent.
   *
   * A trace already marked sampled is ALWAYS recorded, whatever this says —
   * honouring an upstream sampling decision is what keeps a trace from having
   * holes in the middle, which is worse than not having it at all.
   */
  sampleRoot?: () => boolean
}

export function createTracer(options: TracerOptions = {}): Tracer {
  const { sink } = options
  const sampleRoot = options.sampleRoot ?? (() => true)

  return {
    startSpan(name, spanOptions = {}) {
      const parent = spanOptions.parent
      const sampled = parent ? parent.sampled : sampleRoot()
      const context = continueTrace(parent, sampled)

      if (!sink || !sampled) return inertSpan(context)

      const attributes: Record<string, AttributeValue | undefined> = { ...spanOptions.attributes }
      const events: FinishedSpan["events"] = []
      const startTimeUnixNano = nowUnixNano()
      let status: SpanStatusName = "unset"
      let statusMessage: string | undefined
      let ended = false

      return {
        context,
        setAttributes(next) {
          Object.assign(attributes, next)
        },
        addEvent(eventName, eventAttributes) {
          events.push({
            name: eventName,
            timeUnixNano: nowUnixNano(),
            ...(eventAttributes ? { attributes: eventAttributes } : {}),
          })
        },
        setStatus(next, message) {
          status = next
          statusMessage = message
        },
        headers: () => ({
          [TRACEPARENT_HEADER]: formatTraceParent(context),
          ...(context.traceState ? { [TRACESTATE_HEADER]: context.traceState } : {}),
        }),
        end() {
          // A span ended twice would be exported twice, and a collector shows
          // that as two operations that both happened.
          if (ended) return
          ended = true
          sink({
            traceId: context.traceId,
            spanId: context.spanId,
            ...(parent ? { parentSpanId: parent.spanId } : {}),
            name,
            kind: spanOptions.kind ?? "internal",
            startTimeUnixNano,
            endTimeUnixNano: nowUnixNano(),
            attributes,
            status,
            ...(statusMessage ? { statusMessage } : {}),
            events,
          })
        },
      }
    },
  }
}

/**
 * Run work inside a span, ending it on every path.
 *
 * A thrown error is recorded and RE-THROWN: telemetry that swallows a failure
 * changes the program it is measuring.
 */
export async function withSpan<T>(span: Span, run: (span: Span) => Promise<T> | T): Promise<T> {
  try {
    const result = await run(span)
    // Left `unset` unless the caller decided, so a hop can be recorded without
    // this helper claiming success on its behalf.
    return result
  } catch (error) {
    span.setStatus("error", error instanceof Error ? error.message : String(error))
    span.addEvent("exception", {
      "exception.type": error instanceof Error ? error.name : typeof error,
      "exception.message": error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    span.end()
  }
}

export { childContext }
