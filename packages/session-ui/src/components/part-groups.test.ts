import { describe, expect, test } from "bun:test"
import type { AgentContentPart } from "@claxedo/agent-runtime-contract"
import { groupParts, isSubagentToolPart } from "./part-groups"

function tool_(id: string, name: string, input: Record<string, unknown> = {}): AgentContentPart {
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
  test("folds a single context tool but keeps a single work tool standalone", () => {
    expect(shape([tool_("p1", "read")])).toEqual(["context"])
    expect(shape([tool_("p1", "bash")])).toEqual(["part"])
  })

  test("a lone spawn is an agents group too, so delegated work has one shape", () => {
    expect(shape([tool_("p1", "task")])).toEqual(["agents"])
  })

  test("folds runs of two or more work tools and subagent spawns", () => {
    expect(shape([tool_("p1", "bash"), tool_("p2", "bash")])).toEqual(["work:bash"])
    expect(shape([tool_("p1", "task"), tool_("p2", "task")])).toEqual(["agents"])
  })

  test("names a work group after its strongest member: edit beats web beats shell", () => {
    expect(shape([tool_("p1", "bash"), tool_("p2", "webfetch"), tool_("p3", "edit")])).toEqual(["work:edit"])
    expect(shape([tool_("p1", "bash"), tool_("p2", "websearch")])).toEqual(["work:webfetch"])
    expect(shape([tool_("p1", "command"), tool_("p2", "shell")])).toEqual(["work:bash"])
  })

  test("groups the Codex tool vocabulary as well as OpenCode's", () => {
    expect(shape([tool_("p1", "read_file"), tool_("p2", "read")])).toEqual(["context"])
    expect(shape([tool_("p1", "apply_patch"), tool_("p2", "edit_file")])).toEqual(["work:edit"])
  })

  test("any non-groupable part flushes every open run", () => {
    expect(shape([tool_("p1", "read"), text("p2", "hi"), tool_("p3", "read")])).toEqual(["context", "part", "context"])
    expect(shape([tool_("p1", "bash"), tool_("p2", "read"), tool_("p3", "bash")])).toEqual(["part", "context", "part"])
  })

  test("a run switching category flushes without needing a separator part", () => {
    expect(shape([tool_("p1", "bash"), tool_("p2", "bash"), tool_("p3", "read"), tool_("p4", "task"), tool_("p5", "task")]))
      .toEqual(["work:bash", "context", "agents"])
  })

  test("keys name the group's first part so a group survives a re-render", () => {
    expect(groups([tool_("p1", "read"), tool_("p2", "grep")])[0]?.key).toBe("context:p1")
    expect(groups([tool_("p1", "bash"), tool_("p2", "bash")])[0]?.key).toBe("work:p1")
    expect(groups([tool_("p1", "task"), tool_("p2", "task")])[0]?.key).toBe("agents:p1")
    expect(groups([text("p1", "hi")])[0]?.key).toBe("part:a1:p1")
  })
})

describe("work is named by exclusion", () => {
  test("a tool nobody thought to list still joins the run instead of breaking it", () => {
    // Every one of these appears in the captured sessions between shell calls, and
    // each used to flush the run and render as its own loud row.
    for (const tool of ["skill", "sendmessage", "toolsearch", "listagents", "mcp__plugin_posthog_posthog__exec"]) {
      expect(shape([tool_("p1", "bash"), tool_("p2", tool), tool_("p3", "bash")])).toEqual(["work:bash"])
    }
  })

  test("a settled question is never folded into a run of machinery", () => {
    expect(shape([tool_("p1", "bash"), tool_("p2", "question"), tool_("p3", "bash")]))
      .toEqual(["part", "part", "part"])
  })

  test("context, subagents and hidden tools keep their own handling", () => {
    expect(shape([tool_("p1", "bash"), tool_("p2", "read"), tool_("p3", "bash")]))
      .toEqual(["part", "context", "part"])
    expect(shape([tool_("p1", "bash"), tool_("p2", "agent"), tool_("p3", "agent")]))
      .toEqual(["part", "agents"])
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

  test("recognises the Claude harness's own spelling of the spawn tool", () => {
    expect(isSubagentToolPart({ type: "tool", tool: "agent" })).toBe(true)
    expect(isSubagentToolPart({ type: "tool", tool: "Agent" })).toBe(true)
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

describe("harness spellings", () => {
  function named(id: string, tool: string): AgentContentPart {
    return {
      id,
      sessionID: "ses_test",
      messageID: "a1",
      type: "tool",
      tool,
      callID: `${id}_c`,
      state: { status: "completed", input: {}, output: "", title: tool, metadata: {}, time: { start: 1, end: 2 } },
    } as AgentContentPart
  }
  const types = (parts: AgentContentPart[]) =>
    groupParts(parts.map((part) => ({ messageID: "a1", part }))).map((group) => group.type)

  test("Claude's own casing groups the same as OpenCode's", () => {
    expect(types([named("p1", "Bash"), named("p2", "Bash")])).toEqual(["work"])
    expect(types([named("p1", "Read"), named("p2", "Grep")])).toEqual(["context"])
  })

  test("a harness alias groups with the tool it names", () => {
    expect(types([named("p1", "local_shell"), named("p2", "bash")])).toEqual(["work"])
    expect(types([named("p1", "LS"), named("p2", "read_file")])).toEqual(["context"])
  })

  test("consecutive spawns fold however the harness spells them", () => {
    expect(types([named("p1", "Agent"), named("p2", "spawn_agent")])).toEqual(["agents"])
  })
})
