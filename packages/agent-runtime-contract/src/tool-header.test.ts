import { describe, expect, test } from "bun:test"
import type { AgentToolPart, AgentToolState } from "./content"
import { isAgentContentPart } from "./content"
import { toolOpensByDefault, toolPartHeader } from "./tool-header"

function part(tool: string, state: AgentToolState): AgentToolPart {
  return { id: "p", sessionID: "s", messageID: "m", type: "tool", callID: "c", tool, state }
}

const completed = (input: Record<string, unknown>, metadata: Record<string, unknown> = {}, output = "o".repeat(10_000)): AgentToolState => ({
  status: "completed",
  input,
  output,
  title: "title",
  metadata,
  time: { start: 1, end: 2 },
})

describe("toolPartHeader", () => {
  test("a shell row keeps its command, exit code, title and time, and drops its output", () => {
    const header = toolPartHeader(part("bash", completed({ command: "ls", intent: "list", env: "x" }, { output: "big", exitCode: 1 })))
    expect(header).toEqual({
      ...part("bash", { status: "completed", input: { command: "ls", intent: "list" }, output: "", title: "title", metadata: { exitCode: 1 }, time: { start: 1, end: 2 } }),
      headerOnly: true,
    })
    expect(isAgentContentPart(header)).toBe(true)
  })

  test("an edit keeps its path and its diff counts, not the file's contents", () => {
    const filediff = { file: "/w/a.ts", additions: 3, deletions: 1, before: "b".repeat(1000), after: "a".repeat(1000), patch: "p" }
    const header = toolPartHeader(part("edit", completed({ filePath: "/w/a.ts", oldString: "x", newString: "y" }, { filediff, diagnostics: {} })))
    expect(header.state).toMatchObject({ input: { filePath: "/w/a.ts" }, metadata: { filediff: { file: "/w/a.ts", additions: 3, deletions: 1 } } })
  })

  test("a patch keeps each file's path, kind and counts", () => {
    const files = [{ filePath: "/w/a.ts", relativePath: "a.ts", type: "update", additions: 2, deletions: 0, patch: "p".repeat(100), before: "b", after: "a" }]
    const header = toolPartHeader(part("apply_patch", completed({ patchText: "p".repeat(100) }, { files })))
    expect(header.state).toMatchObject({ input: {}, metadata: { files: [{ filePath: "/w/a.ts", relativePath: "a.ts", type: "update", additions: 2, deletions: 0 }] } })
  })

  test("a tool the table does not name keeps its whole input, since its row lists it", () => {
    const header = toolPartHeader(part("mcp__docs__search", completed({ query: "q", limit: 5 }, { raw: "big" })))
    expect(header.state).toMatchObject({ input: { query: "q", limit: 5 }, output: "", metadata: {} })
    expect(header.headerOnly).toBe(true)
  })

  test("a completed tool's attachments are body, so its header carries none", () => {
    const attachments = [{ id: "f", sessionID: "s", messageID: "m", type: "file" as const, mime: "image/png", url: `data:image/png;base64,${"A".repeat(4096)}` }]
    const header = toolPartHeader(part("mcp__browser__screenshot", { ...completed({ url: "u" }), attachments } as AgentToolState))
    expect(header.headerOnly).toBe(true)
    expect(header.state).not.toHaveProperty("attachments")
  })

  test("a first-party Claxedo tool whose row reads its result is sent whole, and one whose row reads only its input is its header", () => {
    const created = part("mcp__claxedo-mcp__task_create", completed({ title: "Ship" }, {}, JSON.stringify({ task: { id: "t1", key: "T-1", title: "Ship", status: "doing" } })))
    expect(toolPartHeader(created)).toBe(created)
    const board = toolPartHeader(part("mcp__claxedo-mcp__sessions_board", completed({ workspace: "ws_1" })))
    expect(board.headerOnly).toBe(true)
    expect(board.state).toMatchObject({ input: { workspace: "ws_1" }, output: "" })
  })

  test("a row with nothing to collapse is sent whole", () => {
    for (const tool of ["question", "exitplanmode", "task"]) {
      const whole = part(tool, completed({ prompt: "p" }))
      expect(toolPartHeader(whole)).toBe(whole)
    }
  })

  test("a pending, running or failed tool keeps its status, and a failure keeps its error", () => {
    expect(toolPartHeader(part("bash", { status: "pending", input: { command: "ls" }, raw: "{\"command\":\"ls\"}" })).state).toEqual({ status: "pending", input: { command: "ls" }, raw: "" })
    expect(toolPartHeader(part("read", { status: "running", input: { filePath: "/a" }, time: { start: 1 } })).state).toEqual({ status: "running", input: { filePath: "/a" }, time: { start: 1 }, metadata: {} })
    expect(toolPartHeader(part("grep", { status: "error", input: { pattern: "x" }, error: "boom", time: { start: 1, end: 2 } })).state).toEqual({ status: "error", input: { pattern: "x" }, error: "boom", metadata: {}, time: { start: 1, end: 2 } })
  })
})

describe("toolOpensByDefault", () => {
  test("the shell setting opens shell rows and the edit setting opens edit, write and patch rows, by any spelling", () => {
    expect(toolOpensByDefault("Bash", { shell: true, edit: false })).toBe(true)
    expect(toolOpensByDefault("bash", { shell: false, edit: true })).toBe(false)
    expect(toolOpensByDefault("edit_file", { shell: false, edit: true })).toBe(true)
    expect(toolOpensByDefault("apply_patch", { shell: true, edit: false })).toBe(false)
    expect(toolOpensByDefault("read", { shell: true, edit: true })).toBeUndefined()
  })
})
