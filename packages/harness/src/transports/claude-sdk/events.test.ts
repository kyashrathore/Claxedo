import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { TurnBroker } from "../../contract"
import { claudeChildFrameKey, claudeTranslator, translateClaude } from "./events"

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
  expect(runtime.ingest({ source: "claude.sdk.message", payload: { type: "keep_alive" } }).state.tasks).toMatchObject({ "native-1": {
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

function recordingBroker() {
  const associated: string[] = []
  const observed: unknown[] = []
  const broker = {
    observeSubagent: async (observation: unknown) => {
      observed.push(observation)
      return { sessionId: `child-${observed.length}`, assistantMessageId: `a-${observed.length}`, created: 1 }
    },
    associateChild: (key: string) => { associated.push(key) },
  } as unknown as TurnBroker
  return { broker, associated, observed }
}

const parentBashCall = { type: "assistant", uuid: "assistant-bash", session_id: "up1", parent_tool_use_id: null,
  message: { id: "req-bash", role: "assistant", content: [{ type: "tool_use", id: "toolu_01STm6g5Pds1uf6iSBzu7sJb", name: "Bash",
    input: { command: "bun run build:packages", description: "Build packages" } }], usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage

const bashHeartbeat = { type: "tool_progress", tool_use_id: "toolu_01STm6g5Pds1uf6iSBzu7sJb-heartbeat-0", tool_name: "Bash",
  parent_tool_use_id: "toolu_01STm6g5Pds1uf6iSBzu7sJb", elapsed_time_seconds: 30, heartbeat: true,
  session_id: "up1", uuid: "b48cb689-4559-4291-9e27-5d206038bcac" } as unknown as SDKMessage

test("a Claude 2.1.285 heartbeat for a plain Bash call is not a child frame and yields nothing", async () => {
  const { runtime, tasks } = claudeTranslator("a1")
  const { broker } = recordingBroker()
  await translateClaude(parentBashCall, runtime, tasks, broker)
  expect(claudeChildFrameKey(bashHeartbeat, tasks)).toBeUndefined()
  expect(await translateClaude(bashHeartbeat, runtime, tasks, broker)).toEqual([])
})

test("a Claude 2.1.285 heartbeat for a running Agent call leaves no phantom tool row in the child", async () => {
  const { runtime, tasks } = claudeTranslator("a1")
  const { broker } = recordingBroker()
  await translateClaude({ type: "assistant", uuid: "assistant-agent", session_id: "up1", parent_tool_use_id: null,
    message: { id: "req-agent", role: "assistant", content: [{ type: "tool_use", id: "toolu_01CM7rPr5fxA7N9D3aD9vJMR", name: "Agent",
      input: { description: "Lane A", prompt: "Clean up", subagent_type: "general-purpose", run_in_background: true } }],
    usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage, runtime, tasks, broker)
  const heartbeat = { type: "tool_progress", tool_use_id: "toolu_01CM7rPr5fxA7N9D3aD9vJMR-heartbeat-0", tool_name: "Agent",
    parent_tool_use_id: "toolu_01CM7rPr5fxA7N9D3aD9vJMR", elapsed_time_seconds: 30, heartbeat: true,
    session_id: "a7e7300f-e560-4376-9ab2-4c65ca2b4268", uuid: "b48cb689-4559-4291-9e27-5d206038bcac" } as unknown as SDKMessage
  expect(await translateClaude(heartbeat, runtime, tasks, broker)).toEqual([])
})

test("a subagent's frame routes to its first-level Agent call", async () => {
  const { runtime, tasks } = claudeTranslator("a1")
  const { broker } = recordingBroker()
  await translateClaude({ type: "assistant", uuid: "assistant-agent", session_id: "up1", parent_tool_use_id: null,
    message: { id: "req-agent", role: "assistant", content: [{ type: "tool_use", id: "toolu_agent", name: "Agent",
      input: { description: "Lane A", prompt: "Clean up" } }], usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage, runtime, tasks, broker)
  const nestedCall = { type: "assistant", uuid: "child-agent", session_id: "up1", parent_tool_use_id: "toolu_agent",
    message: { id: "req-child", role: "assistant", content: [{ type: "tool_use", id: "toolu_nested", name: "Agent",
      input: { description: "Nested", prompt: "Look" } }], usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage
  const routed = await translateClaude(nestedCall, runtime, tasks, broker)
  expect(routed.every((item) => item.route?.kind === "child" && item.route.correlationKey === "toolu_agent")).toBe(true)
  const nestedText = { type: "assistant", uuid: "nested-text", session_id: "up1", parent_tool_use_id: "toolu_nested",
    message: { id: "req-nested", role: "assistant", content: [{ type: "text", text: "found it" }], usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage
  expect(claudeChildFrameKey(nestedText, tasks)).toBe("toolu_agent")
})

test("a create_subagent call a Claude subagent made binds the host child under its own call, not the subagent's Agent call", async () => {
  const { runtime, tasks } = claudeTranslator("a1")
  const { broker, associated } = recordingBroker()
  await translateClaude({ type: "assistant", uuid: "assistant-agent", session_id: "up1", parent_tool_use_id: null,
    message: { id: "req-agent", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Agent",
      input: { description: "Lane A", prompt: "Clean up" } }], usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage, runtime, tasks, broker)
  await translateClaude({ type: "assistant", uuid: "child-create", session_id: "up1", parent_tool_use_id: "toolu_1",
    message: { id: "req-create", role: "assistant", content: [{ type: "tool_use", id: "tool-mcp-nested-1", name: "mcp__claxedo__create_subagent",
      input: { harness: "codex", prompt: "Consult" } }], usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage, runtime, tasks, broker)
  const binding = JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_nested", sessionId: "child-10" })
  await translateClaude({ type: "user", uuid: "child-create-result", session_id: "up1", parent_tool_use_id: "toolu_1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-mcp-nested-1", content: [{ type: "text", text: binding }] }] },
    tool_use_result: [{ type: "text", text: binding }] } as unknown as SDKMessage, runtime, tasks, broker)
  expect(associated).toEqual(["toolu_1", "tool-mcp-nested-1"])
})
