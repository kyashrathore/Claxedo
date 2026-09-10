import { describe, expect, test } from "bun:test"
import { canonicalToolName } from "@claxedo/agent-runtime-contract"
import { createAgentEventRuntime } from "../core/runtime"
import type { HarnessEventAdapter } from "../core/adapter"
import type { AgentRuntimeEvent } from "../contracts/agent-runtime-event"
import { createClientPresentationProjection } from "../projections/client-presentation"
import { claudeSdkAdapter } from "./claude/adapter"
import { codexAppServerAdapter } from "./codex/adapter"
import { cursorSdkAdapter } from "./cursor/adapter"
import { piRpcAdapter } from "./pi/adapter"
import { createAcpEventTranslator } from "./acp/event-translator"

/**
 * Every harness spells its tools differently. The client-presentation projection is the
 * one place that mints a part, so it is the one place that can guarantee a spelling the
 * grouping vocabularies, the renderer registry and the subagent predicate all match.
 *
 * These cases drive the real adapter and the real projection, so a harness whose names
 * arrive uncanonicalised fails here rather than silently rendering ungrouped rows.
 */
type Case = { harness: string; runtime: () => Runtime; events: unknown[]; expected: string[] }

type Runtime = { ingest: (event: never) => { events: AgentRuntimeEvent[] } }

/** Each case builds its own runtime so the five adapter state types never have to unify. */
function harnessRuntime<S>(harness: string, adapter: HarnessEventAdapter<S>): Runtime {
  return createAgentEventRuntime({
    harness,
    threadId: "thread-1",
    adapter,
    clock: () => 0,
    createId: (prefix = "id") => `${prefix}-1`,
  }) as unknown as Runtime
}

function toolsFrom(kase: Case) {
  const runtime = kase.runtime()
  const projection = createClientPresentationProjection({
    sessionId: "session-1",
    directory: "/repo",
    assistantMessageId: "assistant-1",
    clock: () => 0,
  })
  const tools = new Set<string>()
  for (const event of kase.events) {
    for (const envelope of runtime.ingest(event as never).events.flatMap((e) => projection.ingest(e))) {
      const payload = envelope.payload
      if (payload.type !== "message.part.updated") continue
      const part = payload.properties.part
      if (part.type === "tool") tools.add(part.tool)
    }
  }
  return [...tools].sort()
}

const CASES: Case[] = [
  {
    harness: "claude",
    runtime: () => harnessRuntime("claude", claudeSdkAdapter()),
    expected: ["bash", "list", "read", "task"],
    events: [
      { source: "claude.sdk.message", payload: { type: "assistant", message: { content: [
        { type: "tool_use", id: "c1", name: "Bash", input: { command: "bun test" } },
        { type: "tool_use", id: "c2", name: "Read", input: { file_path: "/repo/a.ts" } },
        { type: "tool_use", id: "c3", name: "LS", input: { path: "/repo" } },
        { type: "tool_use", id: "c4", name: "Agent", input: { description: "explore" } },
      ] } } },
    ],
  },
  {
    harness: "codex-app-server",
    runtime: () => harnessRuntime("codex-app-server", codexAppServerAdapter()),
    expected: ["task"],
    events: [
      { source: "codex.app-server", method: "item/started", payload: { threadId: "t1", turnId: "u1", item: {
        id: "spawn-1", type: "collabAgentToolCall", tool: "spawn_agent", status: "inProgress",
        senderThreadId: "t1", receiverThreadIds: ["t2"],
      } } },
    ],
  },
  {
    harness: "cursor",
    runtime: () => harnessRuntime("cursor", cursorSdkAdapter()),
    expected: ["bash"],
    events: [
      { source: "cursor.sdk.message", payload: {
        type: "tool_call", agent_id: "a1", run_id: "r1", call_id: "tool-shell-1",
        name: "shell", status: "running", args: { command: "bun test", workingDirectory: "/repo" },
      } },
    ],
  },
  {
    harness: "pi",
    runtime: () => harnessRuntime("pi", piRpcAdapter()),
    expected: ["bash", "read"],
    events: [
      { source: "pi.rpc", payload: { type: "tool_execution_start", toolCallId: "p1", toolName: "Bash", args: { command: "bun test" } } },
      { source: "pi.rpc", payload: { type: "tool_execution_start", toolCallId: "p2", toolName: "Read", args: { path: "/repo/a.ts" } } },
    ],
  },
  {
    harness: "acp:example",
    runtime: () => harnessRuntime("acp:example", createAcpEventTranslator({ client: "acp:example" })),
    expected: ["bash"],
    events: [
      { source: "acp.jsonrpc", method: "session/update", payload: {
        sessionUpdate: "tool_call", toolCallId: "shell-1", title: "Terminal", kind: "execute",
        rawInput: { command: "printf hi" },
      } },
    ],
  },
]

describe("cross-harness tool name canonicalisation", () => {
  for (const kase of CASES) {
    test(`${kase.harness} mints only canonical tool names`, () => {
      const tools = toolsFrom(kase)
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.filter((tool) => canonicalToolName(tool) !== tool)).toEqual([])
    })

    test(`${kase.harness} folds its spellings onto the shared vocabulary`, () => {
      expect(toolsFrom(kase)).toEqual(kase.expected)
    })
  }
})
