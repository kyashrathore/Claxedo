import { describe, expect, test } from "vitest"

import {
  continueTrace,
  formatTraceParent,
  newSpanId,
  newTraceId,
  parseTraceParent,
  traceContextFromHeaders,
  traceContextHeaders,
} from "./trace-context"

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

describe("traceparent parsing", () => {
  test("reads the example from the specification", () => {
    expect(parseTraceParent(VALID)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true,
    })
  })

  test("carries the sampled flag both ways", () => {
    expect(parseTraceParent(VALID)?.sampled).toBe(true)
    expect(parseTraceParent(VALID.replace(/-01$/, "-00"))?.sampled).toBe(false)
  })

  /**
   * The spec REQUIRES a receiver that cannot parse the header to act as though
   * it were absent and start a new trace. Salvaging a half-valid header is how
   * one broken caller corrupts every trace downstream of it — and a corrupt
   * trace is worse than a missing one, because it looks like evidence.
   */
  test("refuses anything malformed rather than salvaging it", () => {
    for (const value of [
      "",
      "not-a-traceparent",
      // all-zero ids are invalid, not merely unlucky
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      // wrong lengths
      "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01",
      // uppercase hex is not lowercase hex
      "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
      // version ff is forbidden
      "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      // version 00 is exactly four fields
      `${VALID}-extra`,
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
    ]) {
      expect(parseTraceParent(value), value).toBeUndefined()
    }
  })

  /** A LATER version may append fields; the first four keep their meaning. */
  test("accepts a future version with extra fields", () => {
    expect(parseTraceParent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-future")).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      sampled: true,
    })
  })

  test("round-trips through the wire format", () => {
    const context = { traceId: newTraceId(), spanId: newSpanId(), sampled: true }
    expect(parseTraceParent(formatTraceParent(context))).toEqual(context)
  })
})

describe("generated ids", () => {
  test("are the lengths the spec requires and are not reused", () => {
    const traces = new Set(Array.from({ length: 200 }, newTraceId))
    const spans = new Set(Array.from({ length: 200 }, newSpanId))
    expect([...traces].every((id) => /^[0-9a-f]{32}$/.test(id))).toBe(true)
    expect([...spans].every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true)
    expect(traces.size).toBe(200)
    expect(spans.size).toBe(200)
  })
})

describe("reading context off a hop", () => {
  test("reads a Headers, as the control plane and relay see it", () => {
    const headers = new Headers({ traceparent: VALID, tracestate: "vendor=1" })
    expect(traceContextFromHeaders(headers)).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      traceState: "vendor=1",
    })
  })

  /**
   * The host tunnel delivers a plain header MAP whose casing is whatever the
   * original sender used, so a lookup that assumes lowercase silently loses
   * the trace exactly at the hop that is hardest to observe.
   */
  test("reads a plain header map in any casing, as the tunnel delivers it", () => {
    expect(traceContextFromHeaders({ TraceParent: VALID })?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(traceContextFromHeaders({ "TRACEPARENT": VALID })?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
  })

  test("is absent when there is nothing to read", () => {
    expect(traceContextFromHeaders(undefined)).toBeUndefined()
    expect(traceContextFromHeaders({})).toBeUndefined()
    expect(traceContextFromHeaders(new Headers())).toBeUndefined()
  })
})

describe("continuing a trace", () => {
  test("keeps the caller's trace id and becomes its child", () => {
    const incoming = parseTraceParent(VALID)!
    const next = continueTrace(incoming, false)
    expect(next.traceId).toBe(incoming.traceId)
    expect(next.spanId).not.toBe(incoming.spanId)
  })

  /**
   * A hop must not re-decide sampling. Overriding an upstream decision is what
   * produces a trace with a hole in the middle — the shape that makes a
   * distributed trace actively misleading, because the missing hop looks like
   * a hop that never ran.
   */
  test("honours the caller's sampling decision rather than re-deciding", () => {
    const sampledIn = parseTraceParent(VALID)!
    expect(continueTrace(sampledIn, false).sampled).toBe(true)
    const unsampledIn = parseTraceParent(VALID.replace(/-01$/, "-00"))!
    expect(continueTrace(unsampledIn, true).sampled).toBe(false)
  })

  test("starts a fresh trace when nothing was propagated", () => {
    const started = continueTrace(undefined, true)
    expect(started.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(started.sampled).toBe(true)
  })

  test("passes vendor state through untouched", () => {
    const context = { ...parseTraceParent(VALID)!, traceState: "vendor=keep,other=2" }
    expect(traceContextHeaders(context).tracestate).toBe("vendor=keep,other=2")
  })
})
