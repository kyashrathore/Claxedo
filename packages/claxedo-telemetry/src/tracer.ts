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
 * Costs nothing when unconfigured: with no exporter — or no consent —
 * `startSpan` returns a span that records nothing and `end` does no work, so
 * instrumentation can sit on hot paths permanently.
 */

import { MAX_ATTRIBUTES, MAX_EVENTS, sanitizeSpan } from "./redact"
import {
  childContext,
  nowUnixNano,
  type AttributeValue,
  type FinishedSpan,
  type SpanKindName,
  type SpanStatusName,
} from "./span"
import { continueTrace, traceContextHeaders, type TraceContext } from "./trace-context"

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
    headers: () => traceContextHeaders(context),
    end: () => {},
  }
}

export type TracerOptions = {
  /** Where finished spans go. Omit to disable recording entirely. */
  sink?: SpanSink | undefined
  /**
   * Telemetry consent, evaluated per span — the recording boundary.
   *
   * An incoming `sampled` flag is a REQUEST to record, not permission to: a
   * deployment that never agreed to telemetry declines it no matter what the
   * upstream hop asked. Omitting this means no consent answer was given, so a
   * configured sink still receives nothing — the exporter is constructed but
   * never enabled. Denied consent is also stamped onto the propagated context
   * (`sampled: 00`), so the refusal travels downstream instead of asking the
   * next hop to record what this one would not.
   */
  consent?: () => boolean
  /**
   * Whether to record a trace that arrives with no parent.
   *
   * A trace already marked sampled is recorded too, whatever this says —
   * honouring an upstream sampling decision is what keeps a trace from having
   * holes in the middle, which is worse than not having it at all. Consent
   * outranks both: nothing records while `consent` denies it.
   */
  sampleRoot?: () => boolean
  /**
   * The only attribute keys kept on finished spans and their events —
   * including the `exception.*` keys `withSpan` writes. Any other key is
   * dropped before the span reaches the sink. String values are
   * credential-scrubbed either way: an allowed key can still carry a token.
   */
  allowedAttributes?: readonly string[]
}

export function createTracer(options: TracerOptions = {}): Tracer {
  const { sink } = options
  const consent = options.consent ?? (() => false)
  const sampleRoot = options.sampleRoot ?? (() => true)
  const allowed = options.allowedAttributes ? new Set(options.allowedAttributes) : undefined
  // A throwing consent check must not take the traced program down — fail closed.
  const consented = () => {
    try {
      return consent()
    } catch {
      return false
    }
  }

  return {
    startSpan(name, spanOptions = {}) {
      const parent = spanOptions.parent
      const sampled = consented() && (parent ? parent.sampled : sampleRoot())
      const continued = continueTrace(parent, sampled)
      // continueTrace preserves an incoming sampled flag over the argument,
      // so a consent refusal has to be stamped on top — otherwise the next
      // hop is asked to record what this one declined.
      const context = continued.sampled === sampled ? continued : { ...continued, sampled }

      if (!sink || !sampled) return inertSpan(context)

      // Null prototype: an attribute key like `__proto__` is data, not a
      // prototype write.
      const attributes: Record<string, AttributeValue | undefined> = Object.create(null)
      let attributeCount = 0
      const recordAttributes = (next: Record<string, AttributeValue | undefined> | undefined) => {
        if (!next) return
        for (const [key, value] of Object.entries(next)) {
          if (!Object.hasOwn(attributes, key)) {
            if (attributeCount >= MAX_ATTRIBUTES) continue
            attributeCount += 1
          }
          attributes[key] = value
        }
      }
      recordAttributes(spanOptions.attributes)

      const events: FinishedSpan["events"] = []
      const startTimeUnixNano = nowUnixNano()
      let status: SpanStatusName = "unset"
      let statusMessage: string | undefined
      let ended = false

      return {
        context,
        setAttributes: recordAttributes,
        addEvent(eventName, eventAttributes) {
          if (events.length >= MAX_EVENTS) return
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
        headers: () => traceContextHeaders(context),
        end() {
          // A span ended twice would be exported twice, and a collector shows
          // that as two operations that both happened.
          if (ended) return
          ended = true
          sink(
            sanitizeSpan(
              {
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
              },
              allowed,
            ),
          )
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
