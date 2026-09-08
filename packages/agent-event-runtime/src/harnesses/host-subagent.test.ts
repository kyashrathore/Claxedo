import { describe, expect, test } from "bun:test"
import { hostSubagentBinding, isHostSubagentTool } from "./host-subagent"
import { canonicalToolIntent } from "./tool-display"

describe("host subagent classification", () => {
  test("recognises the first-party tool in every harness wrapping", () => {
    expect(isHostSubagentTool("mcp__claxedo__create_subagent")).toBe(true)
    expect(isHostSubagentTool("create_subagent", "claxedo")).toBe(true)
    expect(isHostSubagentTool("create_subagent")).toBe(true)
    expect(isHostSubagentTool("create_subagent", "other-server")).toBe(false)
    expect(isHostSubagentTool("mcp__other__create_subagent")).toBe(false)
    expect(isHostSubagentTool("Task")).toBe(false)
  })

  test("classifies the MCP spawn as task work ahead of the generic mcp intent", () => {
    expect(canonicalToolIntent({ kind: "mcp_tool_call", toolName: "mcp__claxedo__create_subagent" })).toBe("task")
    expect(canonicalToolIntent({ kind: "mcp_tool_call", toolName: "create_subagent" })).toBe("task")
    expect(canonicalToolIntent({ kind: "mcp_tool_call", toolName: "mcp__claxedo__session_list" })).toBe("mcp")
  })

  test("unwraps the child binding from text blocks, structured content, and parsed records", () => {
    const binding = { kind: "claxedo.subagent", subagentKey: "subagent_1", sessionId: "child-1", status: "completed", summary: "done" }
    expect(hostSubagentBinding([{ type: "text", text: JSON.stringify(binding) }])).toEqual({
      subagentKey: "subagent_1",
      sessionId: "child-1",
      status: "completed",
      summary: "done",
    })
    expect(hostSubagentBinding({ content: [{ type: "text", text: JSON.stringify(binding) }] })).toMatchObject({ sessionId: "child-1" })
    expect(hostSubagentBinding({ structuredContent: binding })).toMatchObject({ subagentKey: "subagent_1" })
    expect(hostSubagentBinding(JSON.stringify(binding))).toMatchObject({ subagentKey: "subagent_1" })
    expect(hostSubagentBinding({ status: "success", value: binding })).toMatchObject({ subagentKey: "subagent_1" })
  })

  test("refuses results that merely resemble a binding", () => {
    expect(hostSubagentBinding({ subagentKey: "subagent_1", sessionId: "child-1" })).toBeUndefined()
    expect(hostSubagentBinding([{ type: "text", text: "not json" }])).toBeUndefined()
    expect(hostSubagentBinding({ kind: "claxedo.subagent", sessionId: "child-1" })).toBeUndefined()
    expect(hostSubagentBinding({ kind: "claxedo.subagent", subagentKey: "k", sessionId: "s", status: "bogus" })).toEqual({
      subagentKey: "k",
      sessionId: "s",
    })
  })
})
