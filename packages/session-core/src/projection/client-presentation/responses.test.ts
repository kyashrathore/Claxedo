import { expect, test } from "bun:test"
import type { AgentPresentationEvent, AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { createClientPresentationProjection } from "./projection"

function turn() {
  return createClientPresentationProjection({ sessionId: "session-1", directory: "/repo", assistantMessageId: "msg_turn_1_r", clock: () => 100 })
}

function payloads(projection: ReturnType<typeof turn>, ...events: AgentRuntimeEvent[]): AgentPresentationEvent[] {
  return events.flatMap((event) => projection.ingest(event).map((envelope) => envelope.payload))
}

function partIds(events: AgentPresentationEvent[], type: string) {
  return [...new Set(events.flatMap((event) => (event.type === "message.part.updated" && event.properties.part.type === type ? [event.properties.part.id] : [])))]
}

function refused(projection: ReturnType<typeof turn>) {
  return payloads(projection,
    { type: "response-start", responseId: "msg_refused" },
    { type: "thinking-delta", delta: "Considering" },
    { type: "text-delta", delta: "Here is how" },
  )
}

test("a new response starts a new text part", () => {
  const projection = turn()
  const first = partIds(refused(projection), "text")
  const second = partIds(payloads(projection, { type: "response-start", responseId: "msg_fallback" }, { type: "text-delta", delta: "Safe answer" }), "text")
  expect(first).toHaveLength(1)
  expect(second).toHaveLength(1)
  expect(second[0]).not.toBe(first[0])
})

test("a retraction marks exactly the withdrawn response's text and reasoning, and keeps them", () => {
  const projection = turn()
  const refusedEvents = refused(projection)
  const replacement = partIds(payloads(projection, { type: "response-start", responseId: "msg_fallback" }, { type: "text-delta", delta: "Safe answer" }), "text")
  const retracted = payloads(projection, { type: "response-retracted", responseIds: ["msg_refused"], reason: "refusal" })
  expect(retracted).toEqual([expect.objectContaining({
    type: "message.part.retracted",
    properties: {
      sessionID: "session-1",
      reason: "refusal",
      parts: [...partIds(refusedEvents, "reasoning"), ...partIds(refusedEvents, "text")].map((partID) => ({ messageID: "msg_turn_1_r", partID })),
    },
  })])
  expect(JSON.stringify(retracted)).not.toContain(replacement[0])
})

test("a tool the withdrawn response never ran settles as withdrawn; one that ran keeps its outcome", () => {
  const projection = turn()
  payloads(projection,
    { type: "response-start", responseId: "msg_refused" },
    { type: "tool-start", toolCallId: "ran", toolName: "bash" },
    { type: "tool-output", toolCallId: "ran", output: "done" },
    { type: "tool-start", toolCallId: "pending", toolName: "bash" },
  )
  const tools = payloads(projection, { type: "response-retracted", responseIds: ["msg_refused"], reason: "refusal" })
    .flatMap((event) => (event.type === "message.part.updated" && event.properties.part.type === "tool" ? [event.properties.part] : []))
  expect(tools).toMatchObject([{ callID: "pending", state: { status: "error", error: "Withdrawn: the model refused this response" } }])
})

test("a retraction is applied once, and an unknown response retracts nothing", () => {
  const projection = turn()
  refused(projection)
  expect(payloads(projection, { type: "response-retracted", responseIds: ["msg_refused"], reason: "refusal" })).toHaveLength(1)
  expect(payloads(projection, { type: "response-retracted", responseIds: ["msg_refused"], reason: "refusal" })).toEqual([])
  expect(payloads(projection, { type: "response-retracted", responseIds: ["msg_other"], reason: "refusal" })).toEqual([])
})
