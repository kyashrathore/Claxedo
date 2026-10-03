import { expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { piDurableAdapter } from "./adapter"

function translate() {
  const adapter = piDurableAdapter()
  let state = adapter.createInitialState!()
  return (payload: unknown): AgentRuntimeEvent[] => {
    const result = adapter.translate({ state, event: { source: "pi.durable", payload },
      context: { harness: "pi", threadId: "native-pi", now: () => 1, createId: () => "id" } })
    if (Array.isArray(result)) return result
    state = result.state ?? state
    return result.events ?? []
  }
}

test("an unknown Pi event leaves one debug diagnostic per kind, never the event", () => {
  const send = translate()
  expect(send({ type: "future_event" })).toMatchObject([{ type: "diagnostic", diagnostic: { code: "pi.unrecognized_event", severity: "debug" } }])
  expect(send({ type: "future_event" })).toEqual([])
})

test("a snapshot taken mid-answer emits only the text the stream had not shown yet", () => {
  const send = translate()
  send({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } })
  expect(send({ type: "snapshot", generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
    usage: { models: {}, tools: {} } })).toEqual([{ type: "text-delta", delta: "lo" }])
})

test("final content that contradicts the streamed deltas is refused rather than corrected", () => {
  const send = translate()
  send({ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: "wrong" }] })
  expect(() => send({ type: "message_end", entry: { model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "actual" }] }] } }))
    .toThrow("disagrees")
})
