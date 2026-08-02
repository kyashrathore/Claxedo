import { describe, expect, test } from "bun:test"
import type { HarnessEventAdapter } from "./adapter"
import { createAgentEventRuntime, translateRawHarnessEvent } from "./runtime"
import { cloneSnapshotValue, type RuntimeSnapshot } from "./state"

type State = { count: number }

const adapter: HarnessEventAdapter<State> = {
  name: "test",
  createInitialState: () => ({ count: 0 }),
  translate({ state, event, context }) {
    const next = { count: state.count + 1 }
    return {
      state: next,
      events: [{
        type: "text-delta",
        delta: `${String(event.payload)}:${context.createId("chunk")}:${context.now()}`,
      }],
    }
  },
}

describe("createAgentEventRuntime", () => {
  test("ingests events deterministically and snapshots adapter state", () => {
    const runtime = createAgentEventRuntime({
      harness: "test-provider",
      threadId: "thread-1",
      adapter,
      clock: () => 123,
      createId: () => "fixed",
    })

    expect(runtime.ingest({ source: "test", method: "next", payload: "hello" })).toMatchObject({
      state: { count: 1 },
      events: [{
        type: "text-delta",
        harness: "test-provider",
        threadId: "thread-1",
        delta: "hello:fixed:123",
      }],
      snapshot: {
        version: 1,
        harness: "test-provider",
        threadId: "thread-1",
        adapterState: { count: 1 },
      },
    })
  })

  test("restores adapter state from snapshot", () => {
    const runtime = createAgentEventRuntime({
      harness: "test-provider",
      threadId: "thread-1",
      adapter,
      initialSnapshot: {
        version: 1,
        harness: "test-provider",
        threadId: "thread-1",
        adapterState: { count: 41 },
      },
    })

    expect(runtime.ingest({ source: "test", payload: "x" }).state).toEqual({ count: 42 })
  })

  test("returns snapshots that do not mutate after later ingests", () => {
    type MutableState = { nested: { lastMessageId: string | null } }
    const mutableAdapter: HarnessEventAdapter<MutableState> = {
      name: "mutable",
      createInitialState: () => ({ nested: { lastMessageId: null } }),
      translate({ state, event }) {
        state.nested.lastMessageId = String(event.payload)
        return { state, events: [] }
      },
    }
    const runtime = createAgentEventRuntime({
      harness: "test-provider",
      threadId: "thread-1",
      adapter: mutableAdapter,
    })

    const before = runtime.snapshot()
    runtime.ingest({ source: "test", payload: "m1" })

    expect(before.adapterState.nested.lastMessageId).toBeNull()
  })

  test("clones restored adapter snapshots so runtimes are independent", () => {
    type MutableState = { nested: { lastMessageId: string | null } }
    const mutableAdapter: HarnessEventAdapter<MutableState> = {
      name: "mutable",
      translate({ state, event }) {
        state.nested.lastMessageId = String(event.payload)
        return { state, events: [] }
      },
    }
    const snapshot = {
      version: 1,
      harness: "test-provider",
      threadId: "thread-1",
      adapterState: { nested: { lastMessageId: null } },
    } satisfies RuntimeSnapshot<MutableState>
    const first = createAgentEventRuntime({
      harness: "test-provider",
      threadId: "thread-1",
      adapter: mutableAdapter,
      initialSnapshot: snapshot,
    })
    const second = createAgentEventRuntime({
      harness: "test-provider",
      threadId: "thread-1",
      adapter: mutableAdapter,
      initialSnapshot: snapshot,
    })

    first.ingest({ source: "test", payload: "m1" })

    expect(snapshot.adapterState.nested.lastMessageId).toBeNull()
    expect(second.snapshot().adapterState.nested.lastMessageId).toBeNull()
  })

  test("clones structured-clone-safe snapshot values", () => {
    const circular: { label: string; self?: unknown } = { label: "root" }
    circular.self = circular
    const rich = cloneSnapshotValue({
      createdAt: new Date("2026-06-02T00:00:00.000Z"),
      values: new Map([["count", 1n]]),
    })
    const clonedCircular = cloneSnapshotValue(circular)

    expect(rich.createdAt).toBeInstanceOf(Date)
    expect(rich.createdAt.toISOString()).toBe("2026-06-02T00:00:00.000Z")
    expect(rich.values.get("count")).toBe(1n)
    expect(clonedCircular).not.toBe(circular)
    expect(clonedCircular.self).toBe(clonedCircular)
  })

  test("falls back to JSON-safe snapshot values when structured cloning fails", () => {
    const cloned: unknown = cloneSnapshotValue({
      keep: "value",
      drop: () => "not snapshot safe",
      nested: {
        count: 1,
      },
    })

    expect(cloned).toEqual({
      keep: "value",
      nested: {
        count: 1,
      },
    })
  })

  test("sanitizes JSON fallback values that would otherwise throw", () => {
    const value: {
      keep: string
      count: bigint
      drop: () => string
      self?: unknown
    } = {
      keep: "value",
      count: 1n,
      drop: () => "not snapshot safe",
    }
    value.self = value

    expect(cloneSnapshotValue<unknown>(value)).toEqual({
      keep: "value",
      count: "1",
      self: "[Circular]",
    })
  })

  test("rejects older snapshot versions clearly", () => {
    expect(() => createAgentEventRuntime({
      harness: "test-provider",
      threadId: "thread-1",
      adapter,
      initialSnapshot: {
        version: 0,
        harness: "test-provider",
        threadId: "thread-1",
        adapterState: { count: 0 },
      } as unknown as RuntimeSnapshot<State>,
    })).toThrow("Unsupported RuntimeSnapshot version: 0")
  })

  test("turns adapter throws into diagnostic events", () => {
    const result = translateRawHarnessEvent({
      adapter: {
        name: "bad",
        translate() {
          throw new Error("boom")
        },
      },
      state: {},
      event: { source: "test", method: "explode", payload: { ok: false } },
      context: {
        harness: "test-provider",
        threadId: "thread-1",
        now: () => 0,
        createId: () => "id",
      },
    })

    expect(result.events).toEqual([{
      type: "diagnostic",
      harness: "test-provider",
      threadId: "thread-1",
      raw: { source: "test", method: "explode", payload: { ok: false } },
      diagnostic: {
        code: "runtime.adapter_error",
        message: "boom",
        severity: "error",
        source: "test",
        method: "explode",
        raw: { ok: false },
      },
    }])
  })

  test("normalizes both adapter return conventions", () => {
    const context = {
      harness: "test-provider",
      threadId: "thread-1",
      now: () => 0,
      createId: () => "id",
    }

    expect(translateRawHarnessEvent({
      adapter: {
        name: "array",
        translate: () => [{ type: "text-delta", delta: "array" }],
      },
      state: { count: 0 },
      event: { source: "test", payload: "array" },
      context,
    }).events).toEqual([{
      type: "text-delta",
      delta: "array",
      harness: "test-provider",
      threadId: "thread-1",
      raw: { source: "test", payload: "array" },
    }])

    expect(translateRawHarnessEvent({
      adapter: {
        name: "result",
        translate: ({ state }: { state: State }) => ({
          state: { count: state.count + 1 },
          events: [{ type: "text-delta", delta: "result" }],
        }),
      },
      state: { count: 0 },
      event: { source: "test", payload: "result" },
      context,
    })).toEqual({
      state: { count: 1 },
      events: [{
        type: "text-delta",
        delta: "result",
        harness: "test-provider",
        threadId: "thread-1",
        raw: { source: "test", payload: "result" },
      }],
    })
  })

  test("documents default id factory restore boundary", () => {
    const idAdapter: HarnessEventAdapter<State> = {
      name: "ids",
      createInitialState: () => ({ count: 0 }),
      translate({ state, context }) {
        return {
          state: { count: state.count + 1 },
          events: [{ type: "text-delta", delta: context.createId("fallback") }],
        }
      },
    }
    const first = createAgentEventRuntime({
      harness: "test-provider",
      threadId: "thread-1",
      adapter: idAdapter,
    })

    expect(first.ingest({ source: "test", payload: "first" }).events[0]).toMatchObject({
      type: "text-delta",
      delta: "fallback_000000",
    })

    const restored = createAgentEventRuntime({
      harness: "test-provider",
      threadId: "thread-1",
      adapter: idAdapter,
      initialSnapshot: first.snapshot(),
    })

    expect(restored.ingest({ source: "test", payload: "restored" }).events[0]).toMatchObject({
      type: "text-delta",
      delta: "fallback_000000",
    })
    expect(restored.snapshot().adapterState).toEqual({ count: 2 })
  })
})
