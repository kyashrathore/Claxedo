import { describe, expect, test, vi } from "vitest"

import { encodeOtlpSpans, type FinishedSpan } from "./span"
import { parseTraceParent, TRACEPARENT_HEADER } from "./trace-context"
import { createTracer, withSpan } from "./tracer"

function recorder() {
  const spans: FinishedSpan[] = []
  return { spans, sink: (span: FinishedSpan) => void spans.push(span) }
}

const INCOMING = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

describe("spans across a hop", () => {
  test("a received context becomes the span's parent, keeping one trace id", () => {
    const { spans, sink } = recorder()
    const parent = parseTraceParent(INCOMING)!
    createTracer({ sink }).startSpan("relay.forward", { kind: "server", parent }).end()

    expect(spans[0]).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
      name: "relay.forward",
      kind: "server",
    })
    expect(spans[0]!.spanId).not.toBe("00f067aa0ba902b7")
  })

  /**
   * The span the NEXT hop parents to is this span, not this span's parent.
   * Getting that wrong yields a trace where every hop is a sibling of the
   * browser — the waterfall flattens and causality is lost, while the trace
   * still looks complete.
   */
  test("hands the next hop ITS OWN id as the parent", () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink }).startSpan("cp.request", { parent: parseTraceParent(INCOMING)! })
    const propagated = parseTraceParent(span.headers()[TRACEPARENT_HEADER])!
    span.end()

    expect(propagated.spanId).toBe(spans[0]!.spanId)
    expect(propagated.traceId).toBe(spans[0]!.traceId)
  })

  test("a span with no incoming context starts a new trace with no parent", () => {
    const { spans, sink } = recorder()
    createTracer({ sink }).startSpan("browser.navigate").end()
    expect(spans[0]!.parentSpanId).toBeUndefined()
    expect(spans[0]!.traceId).toMatch(/^[0-9a-f]{32}$/)
  })

  test("records attributes, events and status", () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink }).startSpan("relay.tunnel")
    span.setAttributes({ "http.status_code": 503, "claxedo.workspace_id": "ws_1" })
    span.addEvent("host_offline", { reason: "no_socket" })
    span.setStatus("error", "user_hosted_app_offline")
    span.end()

    expect(spans[0]).toMatchObject({
      attributes: { "http.status_code": 503, "claxedo.workspace_id": "ws_1" },
      status: "error",
      statusMessage: "user_hosted_app_offline",
    })
    expect(spans[0]!.events[0]).toMatchObject({ name: "host_offline", attributes: { reason: "no_socket" } })
  })

  test("ending twice exports once", () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink }).startSpan("once")
    span.end()
    span.end()
    expect(spans).toHaveLength(1)
  })
})

describe("sampling", () => {
  test("records nothing at all when no sink is configured", () => {
    const span = createTracer().startSpan("inert")
    span.setAttributes({ a: 1 })
    span.end()
    // Still propagates: a downstream hop must be able to join this trace.
    expect(span.headers()[TRACEPARENT_HEADER]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-/)
  })

  test("an unsampled root is not recorded but still propagates", () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink, sampleRoot: () => false }).startSpan("skipped")
    span.end()
    expect(spans).toHaveLength(0)
    expect(parseTraceParent(span.headers()[TRACEPARENT_HEADER])?.sampled).toBe(false)
  })

  /**
   * An upstream sampling decision is binding. A hop that re-decides produces a
   * trace with a hole in it, and a missing middle hop reads as a hop that never
   * ran — actively worse than no trace at all.
   */
  test("a sampled caller is recorded even when this hop would not have sampled", () => {
    const { spans, sink } = recorder()
    createTracer({ sink, sampleRoot: () => false })
      .startSpan("forced", { parent: parseTraceParent(INCOMING)! })
      .end()
    expect(spans).toHaveLength(1)
  })
})

describe("withSpan", () => {
  test("ends the span and re-throws, recording the failure", async () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink }).startSpan("fails")
    await expect(withSpan(span, () => Promise.reject(new Error("relay refused")))).rejects.toThrow("relay refused")

    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ status: "error", statusMessage: "relay refused" })
    expect(spans[0]!.events[0]).toMatchObject({
      name: "exception",
      attributes: { "exception.message": "relay refused" },
    })
  })

  test("ends the span on the success path too", async () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink }).startSpan("succeeds")
    await expect(withSpan(span, () => "value")).resolves.toBe("value")
    expect(spans).toHaveLength(1)
  })
})

describe("OTLP encoding", () => {
  test("encodes 64-bit times as strings so nanoseconds survive JSON", () => {
    const { spans, sink } = recorder()
    createTracer({ sink }).startSpan("timed").end()
    const payload = encodeOtlpSpans({ serviceName: "relay" }, spans)
    const encoded = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!

    expect(typeof encoded.startTimeUnixNano).toBe("string")
    // Past 2^53 — a JSON number here would silently lose precision.
    expect(BigInt(encoded.startTimeUnixNano)).toBeGreaterThan(1_700_000_000_000_000_000n)
  })

  test("encodes kinds as the wire integers a collector expects", () => {
    const { spans, sink } = recorder()
    const tracer = createTracer({ sink })
    tracer.startSpan("s", { kind: "server" }).end()
    tracer.startSpan("c", { kind: "client" }).end()
    const encoded = encodeOtlpSpans({ serviceName: "relay" }, spans).resourceSpans[0]!.scopeSpans[0]!.spans
    expect(encoded.map((span) => span.kind)).toEqual([2, 3])
  })

  test("types attribute values and drops absent ones", () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink }).startSpan("attrs")
    span.setAttributes({ text: "a", count: 7, ratio: 1.5, flag: true, missing: undefined })
    span.end()
    const encoded = encodeOtlpSpans({ serviceName: "relay" }, spans).resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    const byKey = Object.fromEntries(encoded.attributes.map((entry) => [entry.key, entry.value]))

    expect(byKey["text"]).toEqual({ stringValue: "a" })
    expect(byKey["count"]).toEqual({ intValue: "7" })
    expect(byKey["ratio"]).toEqual({ doubleValue: 1.5 })
    expect(byKey["flag"]).toEqual({ boolValue: true })
    expect(byKey["missing"], "OTLP has no null attribute value").toBeUndefined()
  })

  test("names the service so hops are distinguishable in one trace", () => {
    const payload = encodeOtlpSpans({ serviceName: "claxedo-relay", serviceInstanceId: "iso-1" }, [])
    const attributes = Object.fromEntries(
      payload.resourceSpans[0]!.resource.attributes.map((entry) => [entry.key, entry.value]),
    )
    expect(attributes["service.name"]).toEqual({ stringValue: "claxedo-relay" })
    expect(attributes["service.instance.id"]).toEqual({ stringValue: "iso-1" })
  })
})

describe("time", () => {
  test("a span's end is never before its start", () => {
    const { spans, sink } = recorder()
    const tracer = createTracer({ sink })
    for (let index = 0; index < 50; index += 1) tracer.startSpan(`s${index}`).end()
    expect(spans.every((span) => span.endTimeUnixNano >= span.startTimeUnixNano)).toBe(true)
  })

  test("falls back to millisecond time where performance is unavailable", async () => {
    const original = globalThis.performance
    // Workers and older embedders do expose `performance`, but a bundle can be
    // evaluated somewhere that does not, and a crash in the tracer would take
    // the traced program with it.
    vi.stubGlobal("performance", undefined)
    try {
      const { nowUnixNano } = await import("./span")
      expect(typeof nowUnixNano()).toBe("bigint")
    } finally {
      vi.stubGlobal("performance", original)
    }
  })
})
