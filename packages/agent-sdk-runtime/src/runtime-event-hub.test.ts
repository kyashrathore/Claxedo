import { describe, expect, test } from "bun:test"
import { AGENT_RUNTIME_EVENT_CONTRACT_VERSION } from "@claxedo/agent-event-runtime"
import { createRuntimeEventHub } from "./runtime-event-hub"
import { sessionIdle } from "./compat-events"

describe("createRuntimeEventHub", () => {
  test("isolates subscriber failures from later global subscribers", () => {
    const hub = createRuntimeEventHub()
    const seen: string[] = []
    const prev = console.error
    console.error = () => {}

    try {
      hub.subscribeGlobal(() => {
        throw new Error("subscriber failed")
      })
      hub.subscribeGlobal((event) => {
        seen.push(event.payload.type)
      })

      hub.publishGlobal({ directory: "/work", payload: sessionIdle("s1") })

      expect(seen).toEqual(["session.idle"])
    } finally {
      console.error = prev
    }
  })

  test("stamps runtime envelopes with the current event contract version", () => {
    const hub = createRuntimeEventHub()
    const seen: unknown[] = []

    hub.subscribeRuntime((event) => {
      seen.push(event)
    })

    hub.publishRuntime({
      directory: "/work",
      sessionId: "session-1",
      payload: { type: "text-delta", delta: "hello" },
    })

    expect(seen).toEqual([{
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/work",
      sessionId: "session-1",
      payload: { type: "text-delta", delta: "hello" },
    }])
  })

  test("rejects explicit runtime envelopes from another contract version", () => {
    const hub = createRuntimeEventHub()

    expect(() => hub.publishRuntime({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION + 1,
      directory: "/work",
      sessionId: "session-1",
      payload: { type: "text-delta", delta: "hello" },
    })).toThrow("unsupported runtime event contract version")
  })
})
