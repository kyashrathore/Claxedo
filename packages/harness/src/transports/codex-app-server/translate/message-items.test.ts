import { expect, test } from "bun:test"
import { translatorRuntime } from "../../../test-support/translator-runtime"
import { codexAppServerAdapter } from "./adapter"

function runtime() {
  const agent = translatorRuntime({
    harness: "codex-app-server",
    threadId: "thread-1",
    adapter: codexAppServerAdapter(),
    clock: () => 0,
    createId: (prefix = "id") => `${prefix}-1`,
  })
  const deltas = (method: string, payload: Record<string, unknown>) => agent.ingest({
    source: "codex.app-server", method, payload: { threadId: "thread-1", turnId: "turn-1", ...payload },
  }).events.flatMap((event) => event.type === "text-delta" || event.type === "thinking-delta" ? [`${event.type}:${event.delta}`] : [])
  return { agent, deltas }
}

test("a second message item right after the first starts its own paragraph", () => {
  const { deltas } = runtime()
  expect(deltas("item/agentMessage/delta", { itemId: "msg-1", delta: "Checking now." })).toEqual(["text-delta:Checking now."])
  expect(deltas("item/completed", { item: { type: "agentMessage", id: "msg-1", text: "Checking now.", phase: "commentary" } })).toEqual([])
  expect(deltas("item/agentMessage/delta", { itemId: "msg-2", delta: "Final" })).toEqual(["text-delta:\n\nFinal"])
  expect(deltas("item/agentMessage/delta", { itemId: "msg-2", delta: " answer." })).toEqual(["text-delta: answer."])
  expect(deltas("item/completed", { item: { type: "agentMessage", id: "msg-2", text: "Final answer.", phase: "final_answer" } })).toEqual([])
})

test("a second reasoning item right after the first starts its own paragraph", () => {
  const { deltas } = runtime()
  expect(deltas("item/reasoning/summaryTextDelta", { itemId: "rs-1", delta: "**Reading the config**", summaryIndex: 0 })).toEqual(["thinking-delta:**Reading the config**"])
  expect(deltas("item/reasoning/summaryTextDelta", { itemId: "rs-2", delta: "**Planning the fix**", summaryIndex: 0 })).toEqual(["thinking-delta:\n\n**Planning the fix**"])
  expect(deltas("item/completed", { item: { type: "reasoning", id: "rs-3", summary: ["**Checking tests**"], content: [] } })).toEqual(["thinking-delta:\n\n**Checking tests**"])
})

test("a message after reasoning or a tool needs no separator: it is already its own part", () => {
  const { deltas } = runtime()
  deltas("item/agentMessage/delta", { itemId: "msg-1", delta: "Checking now." })
  deltas("item/reasoning/summaryTextDelta", { itemId: "rs-1", delta: "think", summaryIndex: 0 })
  expect(deltas("item/agentMessage/delta", { itemId: "msg-2", delta: "Answer" })).toEqual(["text-delta:Answer"])
  deltas("item/started", { item: { type: "commandExecution", id: "cmd-1", command: "ls", cwd: "/repo", status: "inProgress" } })
  expect(deltas("item/agentMessage/delta", { itemId: "msg-3", delta: "After the command" })).toEqual(["text-delta:After the command"])
})

test("a new turn starts without a separator", () => {
  const { deltas } = runtime()
  deltas("item/agentMessage/delta", { itemId: "msg-1", delta: "First turn." })
  deltas("turn/completed", { turn: { id: "turn-1", items: [], status: "completed", error: null } })
  expect(deltas("item/agentMessage/delta", { itemId: "msg-2", delta: "Second turn." })).toEqual(["text-delta:Second turn."])
})

test("a reply after a steered user message starts without a separator", () => {
  const { deltas } = runtime()
  deltas("item/agentMessage/delta", { itemId: "msg-1", delta: "ok" })
  deltas("item/completed", { item: { type: "agentMessage", id: "msg-1", text: "ok", phase: "final_answer" } })
  const steer = { type: "userMessage", id: "user-2", clientId: "steer-1", content: [{ type: "text", text: "H7STEERCODEX", text_elements: [] }] }
  expect(deltas("item/started", { item: steer })).toEqual([])
  expect(deltas("item/completed", { item: steer })).toEqual([])
  expect(deltas("item/agentMessage/delta", { itemId: "msg-2", delta: "ok" })).toEqual(["text-delta:ok"])
})
