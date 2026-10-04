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

test("a Claude 2.1.285 agent resumed through SendMessage in a later process routes its frames under its original Agent call", async () => {
  const { runtime, tasks } = claudeTranslator("a1")
  const { broker, associated, observed } = recordingBroker()
  const session = "a7e7300f-e560-4376-9ab2-4c65ca2b4268"
  await translateClaude({ type: "user", uuid: "44ffac63-9a2b-425a-90ab-85d3d1f4d9f0", session_id: session, parent_tool_use_id: null,
    message: { role: "user", content: [{ tool_use_id: "toolu_01LxqZ8zxkTpU8LH8gBdeU9S", type: "tool_result",
      content: [{ type: "text", text: "{\"success\":true,\"message\":\"Resuming agent ab03639\",\"resumedAgentId\":\"ab03639cdfec8b10f\"}" }] }] },
    tool_use_result: { success: true, message: "Resuming agent ab03639", resumedAgentId: "ab03639cdfec8b10f",
      pin: { id: "ab03639cdfec8b10f", name: "ab03639cdfec8b10f", ref: "8ce2e3" } } } as unknown as SDKMessage, runtime, tasks, broker)
  await translateClaude({ type: "system", subtype: "task_started", uuid: "71313ac4-4cc0-45a8-adc5-51a92657139d", session_id: session,
    task_id: "ab03639cdfec8b10f", tool_use_id: "toolu_01LxqZ8zxkTpU8LH8gBdeU9S", description: "Lane A: server scripts cleanup",
    subagent_type: "general-purpose", task_type: "local_agent", spawn_depth: 1 } as unknown as SDKMessage, runtime, tasks, broker)
  const resumedText = { type: "assistant", uuid: "resumed-text", session_id: session, parent_tool_use_id: "toolu_01CM7rPr5fxA7N9D3aD9vJMR",
    message: { id: "req-resumed", role: "assistant", content: [{ type: "text", text: "Picking up where I left off." }],
      usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage
  const routed = await translateClaude(resumedText, runtime, tasks, broker)

  expect(observed).toMatchObject([{ stableCorrelationId: "ab03639cdfec8b10f", toolCallId: "toolu_01LxqZ8zxkTpU8LH8gBdeU9S", status: "running" }])
  expect(associated).toEqual(["toolu_01LxqZ8zxkTpU8LH8gBdeU9S"])
  expect(routed.length).toBeGreaterThan(0)
  expect(routed.every((item) => item.route?.kind === "child" && item.route.correlationKey === "toolu_01CM7rPr5fxA7N9D3aD9vJMR")).toBe(true)
})

test("a Skill call's forked execution is bound under the Skill call at task_started, before any of its frames", async () => {
  const { runtime, tasks } = claudeTranslator("a1")
  const { broker, associated } = recordingBroker()
  await translateClaude({ type: "assistant", uuid: "skill-call", session_id: "up1", parent_tool_use_id: null,
    message: { id: "req-skill", role: "assistant", content: [{ type: "tool_use", id: "toolu_skill", name: "Skill",
      input: { skill: "review-lanes" } }], usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage, runtime, tasks, broker)
  await translateClaude({ type: "system", subtype: "task_started", uuid: "fork-started", session_id: "up1", task_id: "agent-fork",
    tool_use_id: "toolu_skill", description: "review-lanes", subagent_type: "general-purpose", task_type: "local_agent",
    is_backgrounded: true } as unknown as SDKMessage, runtime, tasks, broker)
  expect(associated).toEqual(["toolu_skill"])
  const forkText = { type: "assistant", uuid: "fork-text", session_id: "up1", parent_tool_use_id: "toolu_skill",
    message: { id: "req-fork", role: "assistant", content: [{ type: "text", text: "Reviewing the lanes." }],
      usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage
  const routed = await translateClaude(forkText, runtime, tasks, broker)
  expect(routed.every((item) => item.route?.kind === "child" && item.route.correlationKey === "toolu_skill")).toBe(true)
})
