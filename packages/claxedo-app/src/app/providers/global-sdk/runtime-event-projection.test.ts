import { describe, expect, test } from "bun:test"
import { AGENT_RUNTIME_EVENT_CONTRACT_VERSION } from "@claxedo/agent-event-runtime/contracts"
import type { RuntimeEventEnvelope } from "./runtime-envelope"
import { projectRuntimeEventEnvelope, type RuntimeProjectionCache } from "./runtime-event-projection"

function envelope(payload: RuntimeEventEnvelope["payload"], assistantMessageId = "msg_turn_r"): RuntimeEventEnvelope {
  return {
    contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
    directory: "/repo",
    sessionId: "session-one",
    assistantMessageId,
    payload,
  }
}

describe("runtime projection lifetime", () => {
  test("terminal events retain final emissions and release only their turn", () => {
    for (const terminal of [
      { type: "finish", sessionId: "session-one" },
      { type: "error", error: "provider failed" },
    ] satisfies RuntimeEventEnvelope["payload"][]) {
      const projections: RuntimeProjectionCache = new Map()
      projectRuntimeEventEnvelope(envelope({ type: "text-delta", delta: "hello" }), projections)
      projectRuntimeEventEnvelope(envelope({ type: "text-delta", delta: "another" }, "msg_another_r"), projections)
      const events = projectRuntimeEventEnvelope(envelope(terminal), projections)
      expect(events.map((event) => event.payload.type)).toEqual(
        terminal.type === "finish" ? ["message.completed", "session.idle"] : ["session.error"],
      )
      expect(events[0]?.payload.properties).toMatchObject({ sessionID: "session-one" })
      expect([...projections.keys()]).toEqual(["session-one:msg_another_r"])
    }
  })

  test("late usage and diagnostics stay visible without recreating a retired accumulator", () => {
    const projections: RuntimeProjectionCache = new Map()
    projectRuntimeEventEnvelope(envelope({ type: "text-delta", delta: "hello" }), projections)
    projectRuntimeEventEnvelope(envelope({ type: "finish", sessionId: "session-one" }), projections)
    const usage = projectRuntimeEventEnvelope(envelope({ type: "usage", contextSize: 100, contextUsed: 20 }), projections)
    const diagnostic = projectRuntimeEventEnvelope(envelope({ type: "diagnostic", diagnostic: { code: "late", message: "usage settled", severity: "info" } }), projections)
    expect(usage.map((event) => event.payload.type)).toEqual(["session.usage"])
    expect(usage[0]?.payload.properties).toMatchObject({ messageID: "msg_turn_r", contextUsed: 20 })
    expect(diagnostic.map((event) => event.payload.type)).toEqual(["runtime.diagnostic"])
    expect(projections.size).toBe(0)
  })

  test("continuing an active stream reuses part identity and does not announce another row", () => {
    const projections: RuntimeProjectionCache = new Map()
    const first = projectRuntimeEventEnvelope(envelope({ type: "text-delta", delta: "hello" }), projections)
    const next = projectRuntimeEventEnvelope(envelope({ type: "text-delta", delta: " again" }), projections)
    expect(next.map((event) => event.payload.type)).toEqual(["message.part.delta"])
    expect(next[0]?.payload.properties).toMatchObject({
      partID: (first.at(-1)?.payload.properties as { partID: string }).partID,
      delta: " again",
    })
    expect(projections.size).toBe(1)
  })
})
