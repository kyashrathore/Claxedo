import { describe, expect, test } from "bun:test"
import { codexHostSubagentObservation } from "./host-subagent"

describe("codex host subagent observation", () => {
  const binding = { kind: "claxedo.subagent", subagentKey: "subagent_host", sessionId: "child-9", status: "running" }
  const completed = (threadId: string, item: Record<string, unknown>) => ({ threadId, turnId: "turn-1", completedAtMs: 1, item })
  const createSubagent = (id: string) => ({
    id,
    type: "mcpToolCall",
    server: "claxedo",
    tool: "create_subagent",
    status: "completed",
    arguments: { harness: "claude", prompt: "Consult" },
    pluginId: null,
    result: { content: [{ type: "text", text: JSON.stringify(binding) }], structuredContent: null, _meta: null },
    error: null,
  })
  const bound = {
    harnessExecutionId: "thread-1",
    subagentKey: "subagent_host",
    status: "running",
    providerId: "child-9",
    providerKind: "claxedo",
    childSessionId: "child-9",
    transcript: { kind: "live" },
  } as const

  test("binds a completed create_subagent item on the turn's thread to the host-minted child as its spawn", () => {
    expect(codexHostSubagentObservation("thread-1", completed("thread-1", createSubagent("mcp-spawn-1")))).toEqual({
      observationId: "codex:host-subagent:thread-1:mcp-spawn-1",
      toolCallId: "mcp-spawn-1",
      toolCallRole: "spawn",
      ...bound,
    })
  })

  test("binds a child thread's create_subagent item to the host-minted child without a spawn edge, since the call is in the child's transcript", () => {
    expect(codexHostSubagentObservation("thread-1", completed("child-thread-2", createSubagent("mcp-spawn-2")))).toEqual({
      observationId: "codex:host-subagent:thread-1:mcp-spawn-2",
      toolCallId: "mcp-spawn-2",
      ...bound,
    })
  })

  test("raises nothing for other MCP tools, other servers, or a result without a binding", () => {
    const observe = (item: Record<string, unknown>) => codexHostSubagentObservation("thread-1", completed("thread-1", item))
    expect(observe({ ...createSubagent("a"), tool: "session_list" })).toBeUndefined()
    expect(observe({ ...createSubagent("a"), server: "other" })).toBeUndefined()
    expect(observe({ ...createSubagent("a"), result: null })).toBeUndefined()
    expect(observe({ id: "a", type: "commandExecution", command: "ls" })).toBeUndefined()
  })
})
