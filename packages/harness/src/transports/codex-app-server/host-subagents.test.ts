import { describe, expect, test } from "bun:test"
import { codexHostSubagentObservation } from "./host-subagents"

describe("a create_subagent item binds the host-minted child", () => {
  const binding = { kind: "claxedo.subagent", subagentKey: "subagent_host", sessionId: "child-9", status: "running" }
  const item = (id: string, overrides: Record<string, unknown> = {}) => ({ id, type: "mcpToolCall", server: "claxedo", tool: "create_subagent",
    status: "completed", arguments: { harness: "claude", prompt: "Consult" }, result: { content: [{ type: "text", text: JSON.stringify(binding) }] }, ...overrides })
  const completed = (threadId: string, value: Record<string, unknown>) => ({ threadId, turnId: "turn-1", item: value })
  const bound = { harnessExecutionId: "thread-1", subagentKey: "subagent_host", status: "running", providerId: "child-9", providerKind: "claxedo",
    childSessionId: "child-9", transcript: { kind: "live" } } as const

  test("as its spawn when the turn's own thread made the call", () => {
    expect(codexHostSubagentObservation("thread-1", completed("thread-1", item("mcp-spawn-1"))))
      .toEqual({ observationId: "codex:host-subagent:thread-1:mcp-spawn-1", toolCallId: "mcp-spawn-1", toolCallRole: "spawn", ...bound })
  })

  test("without a spawn edge when a child thread made the call, since the call is in the child's transcript", () => {
    expect(codexHostSubagentObservation("thread-1", completed("child-thread-2", item("mcp-spawn-2"))))
      .toEqual({ observationId: "codex:host-subagent:thread-1:mcp-spawn-2", toolCallId: "mcp-spawn-2", ...bound })
  })

  test("and no other item binds anything", () => {
    const observe = (value: Record<string, unknown>) => codexHostSubagentObservation("thread-1", completed("thread-1", value))
    expect(observe(item("a", { tool: "session_list" }))).toBeUndefined()
    expect(observe(item("a", { server: "other" }))).toBeUndefined()
    expect(observe(item("a", { result: null }))).toBeUndefined()
    expect(observe({ id: "a", type: "commandExecution", command: "ls" })).toBeUndefined()
  })
})
