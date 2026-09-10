import { describe, expect, test } from "bun:test"
import type { AgentContentPart } from "@claxedo/agent-runtime-contract"
import { groupParts, isSubagentToolPart } from "./part-groups"

function tool(id: string, name: string, input: Record<string, unknown> = {}): AgentContentPart {
  return {
    id,
    sessionID: "ses_test",
    messageID: "a1",
    type: "tool",
    tool: name,
    callID: `${id}_c`,
    state: { status: "completed", input, output: "ok", title: name, metadata: {}, time: { start: 1, end: 2 } },
  } as AgentContentPart
}

function text(id: string, value: string): AgentContentPart {
  return { id, sessionID: "ses_test", messageID: "a1", type: "text", text: value } as AgentContentPart
}

function groups(parts: AgentContentPart[]) {
  return groupParts(parts.map((part) => ({ messageID: "a1", part })))
}

function shape(parts: AgentContentPart[]) {
  return groups(parts).map((group) => (group.type === "work" ? `work:${group.tool}` : group.type))
}

describe("groupParts", () => {
  test("folds a single context tool but keeps a single work tool and a single task standalone", () => {
    expect(shape([tool("p1", "read")])).toEqual(["context"])
    expect(shape([tool("p1", "bash")])).toEqual(["part"])
    expect(shape([tool("p1", "task")])).toEqual(["part"])
  })

  test("folds runs of two or more work tools and subagent spawns", () => {
    expect(shape([tool("p1", "bash"), tool("p2", "bash")])).toEqual(["work:bash"])
    expect(shape([tool("p1", "task"), tool("p2", "task")])).toEqual(["agents"])
  })

  test("names a work group after its strongest member: edit beats web beats shell", () => {
    expect(shape([tool("p1", "bash"), tool("p2", "webfetch"), tool("p3", "edit")])).toEqual(["work:edit"])
    expect(shape([tool("p1", "bash"), tool("p2", "websearch")])).toEqual(["work:webfetch"])
    expect(shape([tool("p1", "command"), tool("p2", "shell")])).toEqual(["work:bash"])
  })

  test("groups the Codex tool vocabulary as well as OpenCode's", () => {
    expect(shape([tool("p1", "read_file"), tool("p2", "read")])).toEqual(["context"])
    expect(shape([tool("p1", "apply_patch"), tool("p2", "edit_file")])).toEqual(["work:edit"])
  })

  test("any non-groupable part flushes every open run", () => {
    expect(shape([tool("p1", "read"), text("p2", "hi"), tool("p3", "read")])).toEqual(["context", "part", "context"])
    expect(shape([tool("p1", "bash"), tool("p2", "read"), tool("p3", "bash")])).toEqual(["part", "context", "part"])
  })

  test("a run switching category flushes without needing a separator part", () => {
    expect(shape([tool("p1", "bash"), tool("p2", "bash"), tool("p3", "read"), tool("p4", "task"), tool("p5", "task")]))
      .toEqual(["work:bash", "context", "agents"])
  })

  test("keys name the group's first part so a group survives a re-render", () => {
    expect(groups([tool("p1", "read"), tool("p2", "grep")])[0]?.key).toBe("context:p1")
    expect(groups([tool("p1", "bash"), tool("p2", "bash")])[0]?.key).toBe("work:p1")
    expect(groups([tool("p1", "task"), tool("p2", "task")])[0]?.key).toBe("agents:p1")
    expect(groups([text("p1", "hi")])[0]?.key).toBe("part:a1:p1")
  })
})

describe("isSubagentToolPart", () => {
  test("treats the runtime's create_subagent MCP call as a subagent card, not a generic tool row", () => {
    expect(isSubagentToolPart({ type: "tool", tool: "task" })).toBe(true)
    expect(isSubagentToolPart({ type: "tool", tool: "mcp__claxedo__create_subagent", state: { input: { intent: "mcp" } } })).toBe(true)
    expect(isSubagentToolPart({ type: "tool", tool: "create_subagent" })).toBe(true)
    expect(isSubagentToolPart({ type: "tool", tool: "mcp__claxedo__session_list", state: { input: { intent: "task" } } })).toBe(true)
    expect(isSubagentToolPart({ type: "tool", tool: "mcp__claxedo__session_list", state: { input: { intent: "mcp" } } })).toBe(false)
    expect(isSubagentToolPart({ type: "tool", tool: "bash" })).toBe(false)
    expect(isSubagentToolPart({ type: "text", tool: "task" })).toBe(false)
  })
})

describe("a read that returned an image", () => {
  function readPart(id: string, attachments?: { mime: string; url: string }[]): AgentContentPart {
    return {
      id,
      sessionID: "ses_test",
      messageID: "a1",
      type: "tool",
      tool: "read",
      callID: `${id}_c`,
      state: {
        status: "completed",
        input: { filePath: "/tmp/shot.png" },
        output: "",
        title: "read",
        metadata: {},
        time: { start: 1, end: 2 },
        ...(attachments ? { attachments } : {}),
      },
    } as AgentContentPart
  }

  test("stays standalone so its thumbnail survives", () => {
    const parts = [readPart("p1"), readPart("p2", [{ mime: "image/png", url: "data:image/png;base64,AA" }])]
    const groups = groupParts(parts.map((part) => ({ messageID: "a1", part })))
    expect(groups.map((g) => g.type)).toEqual(["context", "part"])
  })

  test("a read with a non-image attachment still folds", () => {
    const parts = [readPart("p1"), readPart("p2", [{ mime: "text/plain", url: "data:text/plain;base64,AA" }])]
    const groups = groupParts(parts.map((part) => ({ messageID: "a1", part })))
    expect(groups.map((g) => g.type)).toEqual(["context"])
  })

  test("a pending read cannot have produced anything and still folds", () => {
    const pending = { ...readPart("p2"), state: { status: "pending", input: {}, raw: "" } } as AgentContentPart
    const groups = groupParts([readPart("p1"), pending].map((part) => ({ messageID: "a1", part })))
    expect(groups.map((g) => g.type)).toEqual(["context"])
  })
})
