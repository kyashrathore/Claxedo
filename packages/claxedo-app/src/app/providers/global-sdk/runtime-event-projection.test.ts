import { describe, expect, test } from "bun:test"
import { AGENT_RUNTIME_EVENT_CONTRACT_VERSION } from "@claxedo/agent-event-runtime/contracts"
import { createClientPresentationProjection } from "@claxedo/agent-event-runtime/client-presentation"
import type { RuntimeEventEnvelope } from "./runtime-envelope"
import { compatEventEnvelope, projectRuntimeDiagnosticEnvelope } from "./runtime-event-projection"

function envelope(payload: RuntimeEventEnvelope["payload"]): RuntimeEventEnvelope {
  return { contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION, directory: "/repo", sessionId: "session-one", assistantMessageId: "msg_turn_r", payload }
}

describe("runtime and presentation lane ownership", () => {
  test("partial raw replay cannot mint another text or tool identity beside canonical parts", () => {
    const producer = createClientPresentationProjection({ sessionId: "session-one", assistantMessageId: "msg_turn_r", directory: "/repo" })
    producer.ingest({ type: "text-delta", delta: "Earlier text" })
    producer.ingest({ type: "tool-start", toolCallId: "earlier", toolName: "bash" })
    const replay = [
      { type: "text-delta", delta: "Reviewing virtualization" },
      { type: "tool-start", toolCallId: "spawn", toolName: "task" },
      { type: "tool-input", toolCallId: "spawn", input: { description: "Review virtualization" } },
    ] satisfies RuntimeEventEnvelope["payload"][]
    const canonical = replay.flatMap((event) => producer.ingest(event))
    const admitted = canonical.flatMap((event) => compatEventEnvelope(event) ?? [])
    expect(admitted).toEqual(canonical)
    const parts = admitted.flatMap((event) => event.payload.type === "message.part.updated" ? [event.payload.properties.part] : [])
    expect(parts.some((part) => part.id.startsWith("000002_"))).toBe(true)
    for (let attach = 0; attach < 3; attach++) {
      expect(replay.flatMap((event) => projectRuntimeDiagnosticEnvelope(envelope(event)))).toEqual([])
    }
  })
  test("raw terminal, status and usage frames do not race the canonical presentation bus", () => {
    const events = [
      { type: "finish", sessionId: "session-one" },
      { type: "error", error: "provider failed" },
      { type: "usage", contextSize: 100, contextUsed: 20 },
      { type: "session-status", status: "busy" },
      { type: "step-start", newMessageId: "next" },
    ] satisfies RuntimeEventEnvelope["payload"][]
    expect(events.flatMap((event) => projectRuntimeDiagnosticEnvelope(envelope(event)))).toEqual([])
  })
  test("raw-only routing diagnostics reach the diagnostic surface without opening a message", () => {
    const events = projectRuntimeDiagnosticEnvelope(envelope({ type: "diagnostic", diagnostic: { code: "route", message: "Child route missing", severity: "warn" } }))
    expect(events.map((event) => event.payload.type)).toEqual(["runtime.diagnostic"])
    expect(events[0]?.payload.properties).toMatchObject({ sessionID: "session-one", code: "route" })
  })
})
