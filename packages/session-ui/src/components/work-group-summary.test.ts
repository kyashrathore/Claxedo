import { describe, expect, test } from "bun:test"
import type { AgentToolPart } from "@claxedo/agent-runtime-contract"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { workGroupActiveLabel, workGroupIcon, workGroupSummary, workGroupTitle } from "./work-group-summary"

const i18n = useI18n()

function tool(name: string, input: Record<string, unknown> = {}): AgentToolPart {
  return {
    id: `p_${name}`,
    sessionID: "ses_test",
    messageID: "a1",
    type: "tool",
    tool: name,
    callID: `c_${name}`,
    state: { status: "completed", input, output: "ok", title: name, metadata: {}, time: { start: 1, end: 2 } },
  } as AgentToolPart
}

function running(name: string, input: Record<string, unknown> = {}): AgentToolPart {
  return { ...tool(name, input), state: { status: "running", input, time: { start: 1 } } } as AgentToolPart
}

const title = (parts: AgentToolPart[]) => workGroupTitle(workGroupSummary(parts), false, i18n)

describe("workGroupTitle", () => {
  test("counts the named buckets", () => {
    expect(title([tool("bash"), tool("bash"), tool("edit")])).toBe("Edited 1 file · ran 2 commands")
    expect(title([tool("webfetch"), tool("websearch")])).toBe("Fetched 1 page · searched the web")
  })

  test("counts a run of one unnamed tool by that tool", () => {
    expect(title([tool("skill"), tool("skill")])).toBe("Ran 2 skills")
    expect(title([tool("bash"), tool("skill"), tool("skill")])).toBe("Ran 1 command · ran 2 skills")
  })

  test("names a single unnamed call the way its own row would", () => {
    expect(title([tool("mcp__plugin_posthog_posthog__exec", { command: "call x" })])).toBe("Exec")
    expect(title([tool("bash"), tool("sendmessage", { to: "lane-a" })])).toBe("Ran 1 command · Send message")
    expect(title([tool("skill")])).toBe("Skill")
  })

  test("names the distinct members of a mixed run", () => {
    expect(title([tool("skill"), tool("listagents")])).toBe("Used skill, list agents")
    expect(title([tool("sessions_list"), tool("processes")])).toBe("Used sessions list, processes")
  })

  test("counts a run of one unnamed tool by that tool even when its name is opaque", () => {
    expect(title([tool("mcp__a__x"), tool("mcp__a__x")])).toBe("Ran 2 xs")
  })

  test("a run with no member at all still has a header", () => {
    expect(title([])).toBe("Worked")
    expect(workGroupTitle(workGroupSummary([]), true, i18n)).toBe("Working")
  })
})

describe("workGroupIcon", () => {
  test("prefers the category of the strongest member", () => {
    expect(workGroupIcon([tool("bash"), tool("edit")])).toBe("pencil-line")
    expect(workGroupIcon([tool("bash"), tool("webfetch")])).toBe("magnifying-glass")
    expect(workGroupIcon([tool("bash"), tool("skill")])).toBe("terminal")
  })

  test("a run with no shell, edit or web member does not claim a terminal", () => {
    expect(workGroupIcon([tool("skill"), tool("skill")])).toBe("wrench")
    expect(workGroupIcon([tool("mcp__a__x"), tool("mcp__a__y")])).toBe("mcp")
    expect(workGroupIcon([tool("mcp__a__x"), tool("skill")])).toBe("wrench")
  })
})

describe("workGroupActiveLabel", () => {
  test("reports the live member, not the aggregate", () => {
    expect(workGroupActiveLabel([tool("bash"), running("bash", { command: "bun test" })], i18n)).toBe("Running bun test")
    expect(workGroupActiveLabel([tool("bash")], i18n)).toBeUndefined()
  })

  test("names a running unnamed tool the way the settled summary names it", () => {
    expect(workGroupActiveLabel([running("skill", { name: "pdf" })], i18n)).toBe("Running skill")
    expect(workGroupActiveLabel([running("mcp__plugin_posthog_posthog__exec")], i18n)).toBe("Running Exec")
  })
})


describe("group remains active between calls", () => {
  test("keeps a 10ms command running until the next group or turn completion", () => {
    const first = tool("bash", { command: "pwd" })
    if (first.state.status === "completed") first.state.time = { start: 100, end: 110 }
    expect(workGroupActiveLabel([first], i18n, true)).toBe("Running pwd")
    expect(workGroupActiveLabel([first, running("bash", { command: "bun test" })], i18n, true)).toBe("Running bun test")
    expect(workGroupActiveLabel([first, tool("bash", { command: "bun test" })], i18n, true)).toBe("Running bun test")
    expect(workGroupActiveLabel([first], i18n, false)).toBeUndefined()
  })

  test("uses the last member while the group is still open, even after a failed command", () => {
    const failed = { ...tool("bash"), state: { status: "error", input: { command: "false" }, error: "exit 1", time: { start: 1, end: 11 } } } as AgentToolPart
    expect(workGroupActiveLabel([failed], i18n, true)).toBe("Running false")
    expect(workGroupActiveLabel([tool("bash"), tool("edit")], i18n, true)).toBe("Editing files")
    expect(workGroupActiveLabel([], i18n, true)).toBeUndefined()
  })
})
