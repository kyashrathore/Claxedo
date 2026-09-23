import { describe, expect, test } from "bun:test"
import { createAgentEventRuntime } from "../core/runtime"
import type { HarnessEventAdapter } from "../core/adapter"
import type { AgentRuntimeEvent } from "../contracts/agent-runtime-event"
import { createClientPresentationProjection } from "../projections/client-presentation"
import { claudeSdkAdapter } from "./claude/adapter"
import { codexAppServerAdapter } from "./codex/adapter"
import { cursorSdkAdapter } from "./cursor/adapter"
import { createAcpEventTranslator } from "./acp/event-translator"

/**
 * The transcript draws a proposed plan as a "Planned …" row that opens a Plan tab only
 * for a tool part named `exitplanmode` carrying markdown in `input.plan`. Each case
 * drives a harness's own plan events through the real adapter and projection and pins
 * what that plan becomes, so a harness that starts (or stops) reaching the plan row is
 * a visible diff here. Pi and the embedded OpenCode engine emit no plan events at all:
 * Pi has no plan mode, and OpenCode's plan is an agent that writes ordinary files.
 */
type Runtime = { ingest: (event: never) => { events: AgentRuntimeEvent[] } }

type Settled = {
  tools: { tool: string; plan?: string; planFilePath?: string }[]
  text: string
  todos: string[]
}

const PLAN = "# Finish steering\n\n## Context\n\nSteering reaches the running turn."
const PLAN_FILE = "/Users/me/.claude/plans/snappy-puzzling-rainbow.md"

function harnessRuntime<S>(harness: string, adapter: HarnessEventAdapter<S>): Runtime {
  return createAgentEventRuntime({
    harness,
    threadId: "thread-1",
    adapter,
    clock: () => 0,
    createId: (prefix = "id") => `${prefix}-1`,
  }) as unknown as Runtime
}

/** The parts as a reader would last see them: one entry per part id, text deltas joined. */
function settle(runtime: Runtime, events: unknown[]): Settled {
  const projection = createClientPresentationProjection({
    sessionId: "session-1",
    directory: "/repo",
    assistantMessageId: "assistant-1",
    clock: () => 0,
  })
  const tools = new Map<string, Settled["tools"][number]>()
  let text = ""
  const todos: string[] = []
  for (const event of events) {
    for (const envelope of runtime.ingest(event as never).events.flatMap((e) => projection.ingest(e))) {
      const payload = envelope.payload
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        if (part.type === "tool") {
          const input = part.state.input
          tools.set(part.id, {
            tool: part.tool,
            ...(typeof input.plan === "string" ? { plan: input.plan } : {}),
            ...(typeof input.planFilePath === "string" ? { planFilePath: input.planFilePath } : {}),
          })
        }
        if (part.type === "text") text += part.text
      }
      if (payload.type === "message.part.delta" && payload.properties.field === "text") text += payload.properties.delta
      if (payload.type === "todo.updated") todos.push(...payload.properties.todos.map((todo) => todo.content))
    }
  }
  return { tools: [...tools.values()], text, todos }
}

describe("a proposed plan, per harness", () => {
  test("Claude SDK: EnterPlanMode and ExitPlanMode are tool parts; the plan row gets the markdown and its file", () => {
    const settled = settle(harnessRuntime("claude", claudeSdkAdapter()), [
      { source: "claude.sdk.message", payload: { type: "assistant", message: { content: [
        { type: "tool_use", id: "enter-1", name: "EnterPlanMode", input: {} },
        { type: "tool_use", id: "exit-1", name: "ExitPlanMode", input: { plan: PLAN, planFilePath: PLAN_FILE } },
      ] } } },
    ])
    expect(settled).toEqual({
      tools: [{ tool: "enterplanmode" }, { tool: "exitplanmode", plan: PLAN, planFilePath: PLAN_FILE }],
      text: "",
      todos: [],
    })
  })

  // claude-agent-acp titles ExitPlanMode "Ready to code?" (kind switch_mode) and keeps
  // the real name only in `_meta.claudeCode.toolName`; the part is named from the title.
  test("Claude over ACP: ExitPlanMode keeps its markdown but is named `ready`, so it misses the plan row", () => {
    const settled = settle(harnessRuntime("acp:claude", createAcpEventTranslator({ client: "acp:claude" })), [
      { source: "acp.jsonrpc", method: "session/update", payload: {
        sessionUpdate: "tool_call",
        toolCallId: "exit-1",
        status: "pending",
        title: "Ready to code?",
        kind: "switch_mode",
        rawInput: { plan: PLAN, planFilePath: PLAN_FILE },
        content: [{ type: "content", content: { type: "text", text: PLAN } }],
        _meta: { claudeCode: { toolName: "ExitPlanMode" } },
      } },
    ])
    expect(settled).toEqual({
      tools: [{ tool: "ready", plan: PLAN, planFilePath: PLAN_FILE }],
      text: "",
      todos: [],
    })
  })

  test("Codex app-server: a proposed plan is assistant text and plan steps are a checklist; no tool part", () => {
    const settled = settle(harnessRuntime("codex-app-server", codexAppServerAdapter()), [
      { source: "codex.app-server", method: "item/plan/delta", payload: { threadId: "thread-1", turnId: "turn-1", itemId: "plan-1", delta: PLAN } },
      { source: "codex.app-server", method: "item/completed", payload: { threadId: "thread-1", turnId: "turn-1", item: { id: "plan-1", type: "plan", text: PLAN } } },
      { source: "codex.app-server", method: "turn/plan/updated", payload: {
        threadId: "thread-1",
        turnId: "turn-1",
        plan: [{ step: "Inspect source", status: "completed" }, { step: "Verify behavior", status: "inProgress" }],
      } },
    ])
    expect(settled).toEqual({ tools: [], text: PLAN, todos: ["Inspect source", "Verify behavior"] })
  })

  test("Cursor SDK: createPlan carries its markdown under input.plan but is named `createplan`, so it misses the plan row", () => {
    const settled = settle(harnessRuntime("cursor", cursorSdkAdapter()), [
      { source: "cursor.sdk.message", payload: {
        type: "tool_call", agent_id: "agent-1", run_id: "run-1", call_id: "plan-1",
        name: "createPlan", status: "completed", args: { plan: PLAN },
      } },
    ])
    expect(settled).toEqual({ tools: [{ tool: "createplan", plan: PLAN }], text: "", todos: [] })
  })

  test("generic ACP: a plan is a checklist of entries, never markdown or a tool part", () => {
    const settled = settle(harnessRuntime("acp:example", createAcpEventTranslator({ client: "acp:example" })), [
      { source: "acp.jsonrpc", method: "session/update", payload: {
        sessionUpdate: "plan",
        entries: [{ content: "Inspect source", status: "in_progress", priority: "high" }],
      } },
    ])
    expect(settled).toEqual({ tools: [], text: "", todos: ["Inspect source"] })
  })
})
