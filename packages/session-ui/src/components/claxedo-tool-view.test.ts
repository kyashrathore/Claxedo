import { describe, expect, test } from "bun:test"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import {
  CLAXEDO_TOOL_TITLE_KEYS,
  TASK_LIST_ROW_CAP,
  claxedoToolArguments,
  claxedoToolName,
  claxedoToolResult,
  claxedoToolTitle,
  claxedoToolView,
  taskStatusLabel,
} from "./claxedo-tool-view"

// Outside a provider `useI18n()` yields the shipped English catalog, so these
// assertions read the copy a user reads rather than a stand-in for it.
const i18n = useI18n()

const view = (name: string, input: Record<string, unknown> | undefined, output?: string) =>
  claxedoToolView({ name, input, output, i18n, sessionTitle: (id) => (id === "ses_titled" ? "MCP tasks smoke" : undefined) })

describe("claxedoToolName resolves every harness spelling to the bare tool", () => {
  const CASES: Array<[name: string, tool: string, input: Record<string, unknown> | undefined, expected: string | undefined]> = [
    ["codex first-party server", "process", { server: "claxedo-mcp", tool: "process", arguments: {} }, "process"],
    ["claude first-party server", "mcp__claxedo-mcp__processes", {}, "processes"],
    ["opencode first-party server", "claxedo-mcp_process_start", {}, "process_start"],
    ["explicit server identifies tools outside the old roster", "claxedo-mcp_process", {}, "process"],
    ["generic MCP wrapper uses the declared tool", "mcp", { server: "claxedo-mcp", tool: "process_logs" }, "process_logs"],
    ["similar server names are not first-party", "mcp__claxedo-mcp-other__process", {}, undefined],
    ["bare process is not claimed", "process", {}, undefined],
    ["claude wraps the server into the name", "mcp__claxedo__task_create", { title: "x", intent: "mcp" }, "task_create"],
    ["the projection lowercases claude's spelling", "MCP__CLAXEDO__Task_Start", undefined, "task_start"],
    ["codex sends the bare name and names the server on the input", "task_create", { server: "claxedo", tool: "task_create", arguments: {} }, "task_create"],
    ["codex's server name is matched without case", "task_list", { server: "Claxedo" }, "task_list"],
    ["the embedded opencode engine joins server and tool with one underscore", "claxedo_task_create", { title: "x" }, "task_create"],
    ["the engine spelling is claimed for every roster tool", "claxedo_workspace_lifecycle", undefined, "workspace_lifecycle"],
    ["another server's tool of the same name is not claimed", "mcp__linear__task_create", { intent: "mcp" }, undefined],
    ["codex's bare name is not claimed for another server", "task_create", { server: "linear" }, undefined],
    ["a bare name with no server is not claimed", "task_create", { title: "x" }, undefined],
    ["an engine-style prefix is not claimed for a name off the roster", "claxedo_frobnicate", undefined, undefined],
    ["a wrapped name with nothing after the server is not a tool", "mcp__claxedo__", undefined, undefined],
    ["a native tool is untouched", "bash", { command: "ls" }, undefined],
  ]
  for (const [name, tool, input, expected] of CASES) {
    test(name, () => {
      expect(claxedoToolName(tool, input)).toBe(expected)
    })
  }
})

describe("claxedoToolArguments", () => {
  test("reads codex's nested arguments, parsed when they arrive as a string", () => {
    expect(claxedoToolArguments({ server: "claxedo", tool: "task_create", arguments: { title: "T" } })).toEqual({ title: "T" })
    expect(claxedoToolArguments({ server: "claxedo", arguments: '{"title":"T"}' })).toEqual({ title: "T" })
  })
  test("reads a flat input as it is, and an absent one as empty", () => {
    expect(claxedoToolArguments({ title: "T", intent: "mcp" })).toEqual({ title: "T", intent: "mcp" })
    expect(claxedoToolArguments(undefined)).toEqual({})
  })
})

describe("claxedoToolResult", () => {
  test("parses the pretty JSON the tools answer with", () => {
    expect(claxedoToolResult('{\n  "task": {\n    "id": "tsk_1"\n  },\n  "replayed": false\n}')).toEqual({ task: { id: "tsk_1" }, replayed: false })
  })
  test("yields nothing for prose, a refusal, an array, or an empty output", () => {
    expect(claxedoToolResult("Starting a task's session needs the account setting")).toBeUndefined()
    expect(claxedoToolResult("[1, 2]")).toBeUndefined()
    expect(claxedoToolResult("")).toBeUndefined()
    expect(claxedoToolResult(undefined)).toBeUndefined()
  })
})

describe("claxedoToolTitle", () => {
  test("every roster tool has a catalog title", () => {
    for (const name of Object.keys(CLAXEDO_TOOL_TITLE_KEYS)) {
      const title = claxedoToolTitle(name, i18n)
      expect(title.startsWith("ui.")).toBe(false)
      expect(title.length).toBeGreaterThan(0)
    }
  })
  test("a first-party tool off the roster reads as its own words", () => {
    expect(claxedoToolTitle("frobnicate_widget", i18n)).toBe("Frobnicate widget")
  })
})

describe("claxedoToolView", () => {
  test("task_create links the created task with its key and status, and says when it was replayed", () => {
    const output = JSON.stringify({
      task: { id: "tsk_4f4f", key: "5", title: "MCP smoke", status: "backlog", parent: null, project: "prj", createdFrom: { sessionId: "ses_titled", workspaceId: "w" } },
      replayed: true,
    })
    expect(view("task_create", { title: "MCP smoke", status: "backlog" }, output)).toEqual({
      name: "task_create",
      title: "Create task",
      link: { kind: "task", id: "tsk_4f4f", label: "#5 MCP smoke" },
      status: "backlog",
      note: "already existed",
      facts: [{ label: "Created from", value: "MCP tasks smoke", link: { kind: "session", id: "ses_titled", label: "MCP tasks smoke" } }],
      rows: [],
    })
  })

  test("task_edit links the edited task and keeps its status", () => {
    const output = JSON.stringify({
      task: {
        id: "tsk_4f4f",
        key: "5",
        title: "MCP smoke tonight",
        description: "updated",
        status: "todo",
        revision: 4,
        parent: null,
        project: "prj",
      },
      replayed: false,
    })
    expect(view("task_edit", { task: "tsk_4f4f", title: "MCP smoke tonight" }, output)).toEqual({
      name: "task_edit",
      title: "Edit task",
      link: { kind: "task", id: "tsk_4f4f", label: "#5 MCP smoke tonight" },
      status: "todo",
      facts: [],
      rows: [],
    })
  })

  test("a running task_create shows the title it was asked for", () => {
    expect(view("task_create", { title: "Fix the clip" })).toMatchObject({ title: "Create task", subject: "Fix the clip", status: "todo" })
  })

  test("task_start names the preset, links the started session, and lays the start out as facts", () => {
    const output = JSON.stringify({
      session: { sessionId: "ses_new", workspaceId: "w" },
      slot: "primary",
      attempt: 1,
      preset: { id: "tpr_1", name: "Alt voice" },
      placement: "local",
      destination: "/repo, with that workspace's own skills and plugins",
      created: true,
    })
    expect(view("task_start", { task: "tsk_4f4f", preset: "Alt voice" }, output)).toEqual({
      name: "task_start",
      title: "Start task",
      link: { kind: "task", id: "tsk_4f4f", label: "tsk_4f4f" },
      subject: "Alt voice",
      facts: [
        { label: "Session", value: "ses_new", link: { kind: "session", id: "ses_new", label: "ses_new" } },
        { label: "Preset", value: "Alt voice" },
        { label: "Slot", value: "primary" },
        { label: "Attempt", value: "1" },
        { label: "Placement", value: "local" },
        { label: "Destination", value: "/repo, with that workspace's own skills and plugins", mono: true },
      ],
      rows: [],
    })
  })

  test("task_start reads the task's key and title from its answer, and falls back to the input id before one arrives", () => {
    const output = JSON.stringify({
      task: { id: "tsk_206f", key: "1", title: "MCP smoke: created from a session" },
      session: { sessionId: "ses_new" },
      slot: "primary",
      attempt: 1,
      preset: { name: "Alt voice" },
      created: true,
    })
    expect(view("task_start", { task: "tsk_206f", preset: "Alt voice" }, output).link).toEqual({
      kind: "task",
      id: "tsk_206f",
      label: "#1 MCP smoke: created from a session",
    })
    expect(view("task_start", { task: "tsk_206f", preset: "Alt voice" }).link).toEqual({ kind: "task", id: "tsk_206f", label: "tsk_206f" })
  })

  test("task_start says when the slot was already live", () => {
    const output = JSON.stringify({ session: { sessionId: "ses_old" }, slot: "primary", attempt: 2, preset: { name: "Alt voice" }, created: false })
    expect(view("task_start", { task: "7" }, output)).toMatchObject({ link: { label: "#7" }, note: "already running" })
  })

  test("task_get carries the key, title, status, and the subtask and session counts", () => {
    const output = JSON.stringify({
      task: { id: "tsk_1", key: "3.1", title: "Ship it", status: "doing", parentTaskId: "tsk_0", children: { total: 2, done: 1 } },
      links: [{ slot: "primary" }],
    })
    expect(view("task_get", { task: "tsk_1" }, output)).toEqual({
      name: "task_get",
      title: "Read task",
      link: { kind: "task", id: "tsk_1", label: "#3.1 Ship it" },
      status: "doing",
      facts: [
        { label: "Subtask of", value: "tsk_0", link: { kind: "task", id: "tsk_0", label: "tsk_0" } },
        { label: "Subtasks", value: "2 subtasks" },
        { label: "Sessions", value: "1 session" },
      ],
      rows: [],
    })
  })

  test("task_list shows a capped set of linked rows and counts the rest", () => {
    const tasks = Array.from({ length: TASK_LIST_ROW_CAP + 3 }, (_, index) => ({ id: `tsk_${index}`, key: String(index + 1), title: `Task ${index + 1}`, status: "todo" }))
    const result = view("task_list", { status: "todo" }, JSON.stringify({ project: "prj", tasks, nextCursor: "c2" }))
    expect(result.subject).toBe(`${TASK_LIST_ROW_CAP + 3} tasks`)
    expect(result.status).toBe("todo")
    expect(result.rows).toHaveLength(TASK_LIST_ROW_CAP)
    expect(result.rows[0]).toEqual({ link: { kind: "task", id: "tsk_0", label: "#1 Task 1" }, status: "todo" })
    expect(result.more).toBe("+3 more")
  })

  test("task_list with a further page but no hidden rows says more is available", () => {
    const result = view("task_list", {}, JSON.stringify({ tasks: [{ id: "tsk_0", key: "1", title: "One", status: "done" }], nextCursor: "c2" }))
    expect(result.subject).toBe("1 task")
    expect(result.more).toBe("more available")
  })

  test("session_create links the new session under the title it was given and notes a prompt", () => {
    const output = JSON.stringify({ id: "ses_new", session: {}, prompted: true, worktree: { name: "feat-x", directory: "/repo/.worktrees/feat-x" } })
    expect(view("session_create", { title: "Review the PR", prompt: "go" }, output)).toEqual({
      name: "session_create",
      title: "Create session",
      link: { kind: "session", id: "ses_new", label: "Review the PR" },
      note: "prompted",
      facts: [
        { label: "Worktree", value: "feat-x" },
        { label: "Path", value: "/repo/.worktrees/feat-x", mono: true },
      ],
      rows: [],
    })
  })

  test("session_send links the session and says whether the turn was admitted", () => {
    expect(view("session_send", { session: "ses_titled", text: "Please rerun the tests" }, JSON.stringify({ session: "ses_titled", admitted: true }))).toEqual({
      name: "session_send",
      title: "Send to session",
      link: { kind: "session", id: "ses_titled", label: "MCP tasks smoke" },
      note: "admitted",
      facts: [{ label: "Message", value: "Please rerun the tests" }],
      rows: [],
    })
    expect(view("session_send", { session: "ses_x" }, JSON.stringify({ admitted: false })).note).toBe("not admitted")
  })

  test("codex's nested arguments feed the same card", () => {
    const input = { server: "claxedo", tool: "task_create", arguments: { title: "From codex", status: "todo" } }
    expect(view("task_create", input)).toMatchObject({ subject: "From codex", status: "todo" })
  })

  test("documents_open names the document and shows its path", () => {
    const output = JSON.stringify({ document: "doc_1", name: "Plan", path: "/repo/docs/plan.md", session: "ses_x" })
    expect(view("documents_open", { document: "claxedo://document/doc_1" }, output)).toMatchObject({
      subject: "Plan",
      facts: [
        { label: "Path", value: "/repo/docs/plan.md", mono: true },
        { label: "Session", value: "ses_x", link: { kind: "session", id: "ses_x", label: "ses_x" } },
      ],
    })
  })

  test("process tools name the process and keep their prose answer for the body", () => {
    expect(view("process_start", { process: "web" }, "Process web started on port 4444")).toMatchObject({ subject: "web", text: "Process web started on port 4444" })
    expect(view("process_stop", { process: "web" }, JSON.stringify({ process: "web", state: "stopped", retirement: { leader: "exited", descendants: "unknown" } })))
      .toMatchObject({ subject: "web", note: "stopped" })
    expect(view("process_stop", { process: "web" }, JSON.stringify({ process: "web", state: "unresolved", retirement: { leader: "alive", descendants: "owned" } })))
      .toMatchObject({ subject: "web", note: "not verified stopped" })
    expect(view("process_logs", { name: "web" }, "line 1\nline 2")).toMatchObject({ subject: "web", text: "line 1\nline 2" })
  })

  test("a healthy Stop reads as stopped even though the operation never says succeeded", () => {
    const facts = (cleanup: string, execution = "terminal", persistence = "committed") => ({
      execution: { value: execution, source: "codex", observedAt: 1, generation: "gen_1" },
      cleanup: { value: cleanup, source: "codex", observedAt: 1, generation: "gen_1" },
      persistence: { value: persistence, source: "store", observedAt: 1, generation: "gen_1" },
    })
    const cancelled = (cancellation: unknown) =>
      view("session_cancel_turn", { session: "ses_x" }, `Stopped.\n${JSON.stringify({ session: "ses_x", cancellation })}`)

    expect(cancelled({ kind: "operation", operation: { state: "needs_action", facts: facts("unknown") } }))
      .toMatchObject({ note: "stopped, cleanup unverified" })
    expect(cancelled({ kind: "operation", operation: { state: "succeeded", facts: facts("verified_clear") } }))
      .toMatchObject({ note: "stopped" })
    expect(cancelled({ kind: "operation", operation: { state: "failed", facts: facts("unknown", "running") } }))
      .toMatchObject({ note: "did not stop" })
    expect(cancelled({ kind: "operation", operation: { state: "needs_action", facts: facts("unknown", "terminal", "pending") } }))
      .toMatchObject({ note: "did not stop" })
    expect(cancelled({ kind: "refused", refusal: { kind: "generation_conflict", message: "already ended" } }))
      .toMatchObject({ note: "was not running" })
    expect(cancelled({ kind: "refused", refusal: { kind: "unavailable", message: "machine offline" } }))
      .toMatchObject({ note: "did not stop" })
  })

  test("a prose-only tool shows its answer as it came", () => {
    expect(view("processes", {}, "No processes are configured in this workspace.")).toEqual({
      name: "processes",
      title: "List processes",
      text: "No processes are configured in this workspace.",
      facts: [],
      rows: [],
    })
  })

  test("a first-party tool with no card of its own still gets the verb and its input", () => {
    expect(view("frobnicate_widget", { name: "clip", depth: 2 }, "done")).toEqual({
      name: "frobnicate_widget",
      title: "Frobnicate widget",
      subject: "clip",
      text: "done",
      facts: [],
      rows: [],
    })
  })

  test("a refusal in the output never leaks into the row", () => {
    const refused = view("task_start", { task: "tsk_1", preset: "Alt voice" }, "Starting a task's session needs the account setting")
    expect(refused.link).toEqual({ kind: "task", id: "tsk_1", label: "tsk_1" })
    expect(refused.subject).toBe("Alt voice")
    expect(refused.note).toBeUndefined()
    expect(refused.facts).toEqual([{ label: "Preset", value: "Alt voice" }])
  })
})

describe("taskStatusLabel", () => {
  test("names the five statuses the way the Tasks surface does, and any other as its words", () => {
    expect(["backlog", "todo", "doing", "needs_you", "done"].map((status) => taskStatusLabel(status, i18n))).toEqual([
      "Backlog",
      "To do",
      "In progress",
      "Needs you",
      "Done",
    ])
    expect(taskStatusLabel("on_hold", i18n)).toBe("on hold")
  })
})
