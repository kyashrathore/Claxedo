import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { TurnBroker } from "../../contract"
import { claudeTranslator, translateClaude } from "./translate"

test("an unknown Claude SDK message becomes a bounded unrecognized diagnostic", async () => {
  const { runtime, tasks } = claudeTranslator("a1")
  const broker = { observeSubagent: async () => undefined } as unknown as TurnBroker
  const payload = { type: "future_event", body: "x".repeat(10_000) } as unknown as SDKMessage
  const events = await translateClaude(payload, runtime, tasks, broker)
  expect(events[0]?.event.type).toBe("diagnostic")
  if (events[0]?.event.type === "diagnostic") {
    expect(events[0].event.diagnostic.code).toBe("unrecognized-event")
    expect(typeof events[0].event.diagnostic.raw).toBe("string")
    if (typeof events[0].event.diagnostic.raw === "string") expect(Buffer.byteLength(events[0].event.diagnostic.raw)).toBeLessThanOrEqual(4096)
  }
})

test("a Claude Task spawn associates its child with the routed tool call", async () => {
  const { runtime, tasks } = claudeTranslator("a1")
  const associated: string[] = []
  const broker = { observeSubagent: async () => ({ sessionId: "child-1", assistantMessageId: "a2", created: 1 }),
    associateChild: (key: string) => { associated.push(key) } } as unknown as TurnBroker
  const message = { type: "assistant", uuid: "assistant-1", session_id: "up1", parent_tool_use_id: null,
    message: { id: "req-1", role: "assistant", content: [{ type: "tool_use", id: "tool-task-1", name: "Task",
      input: { description: "Review", prompt: "Review this" } }], usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage
  await translateClaude(message, runtime, tasks, broker)
  expect(associated).toEqual(["tool-task-1"])
})

test("the Claude translator seeds restart-visible native todos", () => {
  const { runtime } = claudeTranslator("a1", [{ id: "native-1", content: "Finish review", status: "in_progress", priority: "medium" }])
  expect(runtime.snapshot().adapterState.tasks).toMatchObject({ "native-1": {
    id: "native-1", description: "Finish review", status: "in_progress",
  } })
})

test("a terminal Claude result uses the translator and keeps its source", async () => {
  const { runtime, tasks } = claudeTranslator("a1")
  const broker = { observeSubagent: async () => undefined } as unknown as TurnBroker
  const result = { type: "result", subtype: "success", session_id: "up1", uuid: "result-1", is_error: false,
    num_turns: 1, result: "done", usage: {} } as unknown as SDKMessage
  const events = await translateClaude(result, runtime, tasks, broker)
  expect(events.some((item) => item.event.type === "finish")).toBe(true)
  expect(events.every((item) => item.source?.method === "claude.result")).toBe(true)
})
