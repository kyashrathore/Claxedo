import { describe, expect, test } from "bun:test"
import { createClientPresentationProjection } from "@claxedo/agent-event-runtime/client-presentation"
import { compatEventEnvelope } from "./presentation-frames"

describe("stream frame admission", () => {
  test("every canonical presentation frame the runtime projects is admitted unchanged", () => {
    const producer = createClientPresentationProjection({ sessionId: "session-one", assistantMessageId: "msg_turn_r", directory: "/repo" })
    producer.ingest({ type: "text-delta", delta: "Earlier text" })
    producer.ingest({ type: "tool-start", toolCallId: "earlier", toolName: "bash" })
    const canonical = [
      { type: "text-delta", delta: "Reviewing virtualization" },
      { type: "tool-start", toolCallId: "spawn", toolName: "task" },
      { type: "tool-input", toolCallId: "spawn", input: { description: "Review virtualization" } },
    ].flatMap((event) => producer.ingest(event as Parameters<typeof producer.ingest>[0]))
    const admitted = canonical.flatMap((event) => compatEventEnvelope(event) ?? [])
    expect(admitted).toEqual(canonical)
    const parts = admitted.flatMap((event) => event.payload.type === "message.part.updated" ? [event.payload.properties.part] : [])
    expect(parts.some((part) => part.id.startsWith("000002_"))).toBe(true)
  })
})
