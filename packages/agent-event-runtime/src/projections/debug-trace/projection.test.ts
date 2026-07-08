import { describe, expect, test } from "bun:test"
import { createDebugTraceProjection } from "./projection"

describe("createDebugTraceProjection", () => {
  test("traces normal runtime events with harness, thread, raw, and diagnostics", () => {
    const projection = createDebugTraceProjection()

    expect(projection.ingest({
      type: "text-delta",
      delta: "hello",
      harness: "provider-1",
      threadId: "thread-1",
      raw: { source: "provider", payload: { text: "hello" } },
      diagnostics: [{
        code: "provider.note",
        message: "note",
        severity: "info",
      }],
    })).toEqual([{
      runtimeType: "text-delta",
      harness: "provider-1",
      threadId: "thread-1",
      raw: { source: "provider", payload: { text: "hello" } },
      diagnostics: [{
        code: "provider.note",
        message: "note",
        severity: "info",
      }],
    }])
  })

  test("traces diagnostic runtime events with the diagnostic payload", () => {
    const projection = createDebugTraceProjection()

    expect(projection.ingest({
      type: "diagnostic",
      harness: "provider-1",
      threadId: "thread-1",
      raw: { source: "provider", method: "event", payload: { broken: true } },
      diagnostic: {
        code: "runtime.adapter_error",
        message: "bad frame",
        severity: "error",
        source: "provider",
        method: "event",
        raw: { broken: true },
      },
    })).toEqual([{
      runtimeType: "diagnostic",
      harness: "provider-1",
      threadId: "thread-1",
      raw: { source: "provider", method: "event", payload: { broken: true } },
      diagnostics: {
        code: "runtime.adapter_error",
        message: "bad frame",
        severity: "error",
        source: "provider",
        method: "event",
        raw: { broken: true },
      },
    }])
  })

  test("snapshots and restores trace counts", () => {
    const first = createDebugTraceProjection()
    first.ingest({ type: "text-delta", delta: "one" })
    first.ingest({ type: "thinking-delta", delta: "two" })

    const restored = createDebugTraceProjection({ initialSnapshot: first.snapshot() })
    restored.ingest({ type: "text-delta", delta: "three" })

    expect(restored.snapshot()).toEqual({
      version: 1,
      projection: "debug-trace",
      state: { count: 3 },
    })
  })
})
