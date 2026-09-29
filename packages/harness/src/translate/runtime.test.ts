import { describe, expect, test } from "bun:test"
import type { HarnessEventAdapter } from "./adapter"
import { createAgentEventRuntime, translateRawHarnessEvent } from "./runtime"

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
  test("ingests events deterministically and carries the adapter state forward", () => {
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
    })
    expect(runtime.ingest({ source: "test", method: "next", payload: "again" }).state).toEqual({ count: 2 })
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
      }],
    })
  })

})

test("keeps the raw provider frame on diagnostic-surface events only", () => {
  const result = translateRawHarnessEvent({
    adapter: {
      name: "mixed",
      translate: () => ({
        events: [
          { type: "text-delta", delta: "plain" },
          { type: "tool-start", toolCallId: "tool-1", toolName: "read" },
          { type: "harness-notice", code: "note", message: "heads up" },
          { type: "rate-limit", status: "limited", reason: "slow down" },
        ],
      }),
    },
    state: {},
    event: { source: "test", method: "frame", payload: { secret: "wire-secret" } },
    context: {
      harness: "test-provider",
      threadId: "thread-1",
      now: () => 0,
      createId: () => "id",
    },
  })

  const text = result.events.find((event) => event.type === "text-delta")
  const tool = result.events.find((event) => event.type === "tool-start")
  const notice = result.events.find((event) => event.type === "harness-notice")
  const rateLimit = result.events.find((event) => event.type === "rate-limit")
  expect(text).not.toHaveProperty("raw")
  expect(tool).not.toHaveProperty("raw")
  expect(JSON.stringify([text, tool])).not.toContain("wire-secret")
  expect(notice).toMatchObject({ raw: { source: "test", method: "frame" } })
  expect(rateLimit).toMatchObject({ raw: { source: "test", method: "frame" } })
})
