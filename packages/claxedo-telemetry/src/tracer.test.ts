import { describe, expect, test, vi } from "vitest"

import { MAX_ATTRIBUTES, MAX_EVENTS } from "./redact"
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
    createTracer({ sink, consent: () => true }).startSpan("relay.forward", { kind: "server", parent }).end()

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
    const span = createTracer({ sink, consent: () => true }).startSpan("cp.request", { parent: parseTraceParent(INCOMING)! })
    const propagated = parseTraceParent(span.headers()[TRACEPARENT_HEADER])!
    span.end()

    expect(propagated.spanId).toBe(spans[0]!.spanId)
    expect(propagated.traceId).toBe(spans[0]!.traceId)
  })

  test("a span with no incoming context starts a new trace with no parent", () => {
    const { spans, sink } = recorder()
    createTracer({ sink, consent: () => true }).startSpan("browser.navigate").end()
    expect(spans[0]!.parentSpanId).toBeUndefined()
    expect(spans[0]!.traceId).toMatch(/^[0-9a-f]{32}$/)
  })

  test("records attributes, events and status", () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink, consent: () => true }).startSpan("relay.tunnel")
    span.setAttributes({ "http.status_code": 503, "claxedo.workspace_id": "ws_1" })
    span.addEvent("host_offline", { reason: "no_socket" })
    span.setStatus("error", "host_tunnel_offline")
    span.end()

    expect(spans[0]).toMatchObject({
      attributes: { "http.status_code": 503, "claxedo.workspace_id": "ws_1" },
      status: "error",
      statusMessage: "host_tunnel_offline",
    })
    expect(spans[0]!.events[0]).toMatchObject({ name: "host_offline", attributes: { reason: "no_socket" } })
  })

  test("ending twice exports once", () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink, consent: () => true }).startSpan("once")
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
    const span = createTracer({ sink, consent: () => true, sampleRoot: () => false }).startSpan("skipped")
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
    createTracer({ sink, consent: () => true, sampleRoot: () => false })
      .startSpan("forced", { parent: parseTraceParent(INCOMING)! })
      .end()
    expect(spans).toHaveLength(1)
  })
})

describe("consent", () => {
  /**
   * A sampled inbound flag is a REQUEST to record, not consent to. With
   * consent off the hop records nothing, and the refusal travels downstream
   * as `sampled: 00` rather than asking the next hop to record what this one
   * declined.
   */
  test("a sampled inbound request records nothing when consent is disabled", () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink, consent: () => false }).startSpan("hop", {
      kind: "server",
      parent: parseTraceParent(INCOMING)!,
    })
    span.setAttributes({ "http.status_code": 200 })
    span.end()

    expect(spans).toHaveLength(0)
    expect(parseTraceParent(span.headers()[TRACEPARENT_HEADER])).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      sampled: false,
    })
  })

  test("is evaluated per span, so withdrawal stops what comes after", () => {
    const { spans, sink } = recorder()
    let granted = true
    const tracer = createTracer({ sink, consent: () => granted })
    tracer.startSpan("before").end()
    granted = false
    tracer.startSpan("after").end()

    expect(spans.map((span) => span.name)).toEqual(["before"])
  })

  test("a sink wired without a consent answer receives nothing", () => {
    const { spans, sink } = recorder()
    createTracer({ sink }).startSpan("unconsented").end()
    expect(spans).toHaveLength(0)
  })

  test("a throwing consent check fails closed instead of breaking the traced code", () => {
    const { spans, sink } = recorder()
    const broken = () => {
      throw new Error("consent store down")
    }
    expect(() => createTracer({ sink, consent: broken }).startSpan("still-runs").end()).not.toThrow()
    expect(spans).toHaveLength(0)
  })
})

describe("bounds", () => {
  test("attributes and events stop growing past the cap, and a known key still updates", () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink, consent: () => true }).startSpan("hot")
    for (let index = 0; index < MAX_ATTRIBUTES * 2; index += 1) span.setAttributes({ [`k${index}`]: index })
    for (let index = 0; index < MAX_EVENTS * 2; index += 1) span.addEvent(`e${index}`)
    span.setAttributes({ k0: "updated" })
    span.end()

    expect(Object.keys(spans[0]!.attributes)).toHaveLength(MAX_ATTRIBUTES)
    expect(spans[0]!.attributes["k0"]).toBe("updated")
    expect(spans[0]!.events).toHaveLength(MAX_EVENTS)
  })

  test("a span arriving from elsewhere is bounded at encode too", () => {
    const foreign: FinishedSpan = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      name: "remote.op",
      kind: "server",
      startTimeUnixNano: 1n,
      endTimeUnixNano: 2n,
      attributes: Object.fromEntries(Array.from({ length: MAX_ATTRIBUTES * 2 }, (_, i) => [`k${i}`, i])),
      status: "unset",
      events: Array.from({ length: MAX_EVENTS * 2 }, (_, i) => ({ name: `e${i}`, timeUnixNano: 1n })),
    }
    const encoded = encodeOtlpSpans({ serviceName: "relay" }, [foreign]).resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    expect(encoded.attributes).toHaveLength(MAX_ATTRIBUTES)
    expect(encoded.events).toHaveLength(MAX_EVENTS)
  })
})

describe("withSpan", () => {
  test("ends the span and re-throws, recording the failure", async () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink, consent: () => true }).startSpan("fails")
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
    const span = createTracer({ sink, consent: () => true }).startSpan("succeeds")
    await expect(withSpan(span, () => "value")).resolves.toBe("value")
    expect(spans).toHaveLength(1)
  })
})

describe("redaction", () => {
  test("withSpan scrubs credential-bearing URLs and bodies before the sink sees them", async () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink, consent: () => true }).startSpan("fetch")
    const failure = new Error(
      `POST https://deploy:s3cret-pw@relay.example.com/v1 failed: 401 {"error":"bad_auth","token":"sk_live_123"}`,
    )
    await expect(withSpan(span, () => Promise.reject(failure))).rejects.toThrow("s3cret-pw")

    const finished = spans[0]!
    const serialized = JSON.stringify(finished, (_key, value: unknown) =>
      typeof value === "bigint" ? String(value) : value,
    )
    expect(serialized).not.toContain("s3cret-pw")
    expect(serialized).not.toContain("sk_live_123")
    expect(finished.statusMessage).toContain("https://[redacted]@relay.example.com")
    expect(finished.events[0]!.attributes).toMatchObject({
      "exception.type": "Error",
      "exception.message": expect.stringContaining(`"token":"[redacted]"`),
    })
  })

  test("allowedAttributes drops undeclared keys on spans and events", () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink, consent: () => true, allowedAttributes: ["http.status_code", "attempt"] }).startSpan("op", {
      attributes: { "http.status_code": 200, "debug.payload": "token=x" },
    })
    span.setAttributes({ "db.statement": "select * from users" })
    span.addEvent("retry", { attempt: 2, "debug.payload": "secret" })
    span.end()

    expect(spans[0]!.attributes).toEqual({ "http.status_code": 200 })
    expect(spans[0]!.events[0]!.attributes).toEqual({ attempt: 2 })
  })

  test("an oversized error is capped instead of filling the span", async () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink, consent: () => true }).startSpan("huge")
    await expect(withSpan(span, () => Promise.reject(new Error("e".repeat(5000))))).rejects.toThrow()
    expect(spans[0]!.statusMessage!.length).toBeLessThan(600)
  })

  test("the OTLP encoder scrubs a span it did not produce", () => {
    const foreign: FinishedSpan = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      name: "remote.op",
      kind: "server",
      startTimeUnixNano: 1n,
      endTimeUnixNano: 2n,
      attributes: { "http.url": "https://user:pw@internal.example/x" },
      status: "error",
      statusMessage: "Authorization: Bearer tok_9",
      events: [],
    }
    const payload = encodeOtlpSpans({ serviceName: "relay" }, [foreign])
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain("user:pw")
    expect(serialized).not.toContain("tok_9")
  })
})

describe("OTLP encoding", () => {
  test("encodes 64-bit times as strings so nanoseconds survive JSON", () => {
    const { spans, sink } = recorder()
    createTracer({ sink, consent: () => true }).startSpan("timed").end()
    const payload = encodeOtlpSpans({ serviceName: "relay" }, spans)
    const encoded = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!

    expect(typeof encoded.startTimeUnixNano).toBe("string")
    // Past 2^53 — a JSON number here would silently lose precision.
    expect(BigInt(encoded.startTimeUnixNano)).toBeGreaterThan(1_700_000_000_000_000_000n)
  })

  test("encodes kinds as the wire integers a collector expects", () => {
    const { spans, sink } = recorder()
    const tracer = createTracer({ sink, consent: () => true })
    tracer.startSpan("s", { kind: "server" }).end()
    tracer.startSpan("c", { kind: "client" }).end()
    const encoded = encodeOtlpSpans({ serviceName: "relay" }, spans).resourceSpans[0]!.scopeSpans[0]!.spans
    expect(encoded.map((span) => span.kind)).toEqual([2, 3])
  })

  test("types attribute values and drops absent ones", () => {
    const { spans, sink } = recorder()
    const span = createTracer({ sink, consent: () => true }).startSpan("attrs")
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
    const tracer = createTracer({ sink, consent: () => true })
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
