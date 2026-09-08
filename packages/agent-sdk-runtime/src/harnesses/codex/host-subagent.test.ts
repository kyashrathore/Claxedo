import { describe, expect, test } from "bun:test"
import { codexHostSubagentObservation } from "./host-subagent"

describe("codex host subagent observation", () => {
  test("binds a completed create_subagent item to the host-minted child", () => {
    expect(codexHostSubagentObservation("thread-1", {
      id: "mcp-spawn-1",
      type: "mcpToolCall",
      server: "claxedo",
      tool: "create_subagent",
      status: "completed",
      arguments: { harness: "claude", prompt: "Consult" },
      result: { content: [{ type: "text", text: JSON.stringify({ kind: "claxedo.subagent", subagentKey: "subagent_host", sessionId: "child-9", status: "running" }) }] },
    })).toEqual({
      observationId: "codex:host-subagent:thread-1:mcp-spawn-1",
      harnessExecutionId: "thread-1",
      subagentKey: "subagent_host",
      toolCallId: "mcp-spawn-1",
      toolCallRole: "spawn",
      status: "running",
      providerId: "child-9",
      providerKind: "claxedo",
      childSessionId: "child-9",
      transcript: { kind: "live" },
    })
  })

  test("raises nothing for other MCP tools, other servers, or a result without a binding", () => {
    const binding = { content: [{ type: "text", text: JSON.stringify({ kind: "claxedo.subagent", subagentKey: "k", sessionId: "s" }) }] }
    expect(codexHostSubagentObservation("thread-1", { id: "a", type: "mcpToolCall", server: "claxedo", tool: "session_list", result: binding })).toBeUndefined()
    expect(codexHostSubagentObservation("thread-1", { id: "a", type: "mcpToolCall", server: "other", tool: "create_subagent", result: binding })).toBeUndefined()
    expect(codexHostSubagentObservation("thread-1", { id: "a", type: "mcpToolCall", server: "claxedo", tool: "create_subagent", result: null })).toBeUndefined()
    expect(codexHostSubagentObservation("thread-1", { id: "a", type: "commandExecution", command: "ls" })).toBeUndefined()
  })
})
