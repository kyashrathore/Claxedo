import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import type { AgentAssistantMessage, AgentToolPart, AgentToolState } from "@claxedo/agent-runtime-contract"
import { DataProvider } from "@/ui/session-kit-context"
import { Part } from "@/ui/session-kit"
import { tasksRoute } from "@/platform/identity/route"

const message: AgentAssistantMessage = {
  id: "msg-1",
  sessionID: "ses-1",
  role: "assistant",
  time: { created: 1 },
  parentID: "msg-0",
  modelID: "claude-opus-5",
  providerID: "anthropic",
  mode: "default",
  agent: "build",
  path: { cwd: "/repo", root: "/repo" },
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
}

const TASK_ID = "tsk_4f4ff3c1-558e-4d87-a286-91d576421af5"

function toolPart(tool: string, state: AgentToolState): AgentToolPart {
  return { id: "prt-tool", sessionID: "ses-1", messageID: "msg-1", type: "tool", callID: "call-1", tool, state }
}

function completed(input: Record<string, unknown>, output: unknown): AgentToolState {
  return {
    status: "completed",
    input,
    output: typeof output === "string" ? output : JSON.stringify(output, null, 2),
    title: "",
    metadata: {},
    time: { start: 1, end: 2 },
  }
}

function mount(part: AgentToolPart, navigate?: { task?: (id: string) => void; session?: (id: string) => void }) {
  return render(() => (
    <DialogProvider>
      <DataProvider
        data={{ agent: [], session: [{ id: "ses_tasks_1", title: "MCP tasks smoke" }], session_status: {}, session_diff: {}, message: {}, part: {} } as never}
        directory="/repo"
        onSessionHref={(id) => `/s/${id}`}
        onTaskHref={(id) => tasksRoute({ kind: "task", taskId: id })}
        onNavigateToTask={navigate?.task}
        onNavigateToSession={navigate?.session}
      >
        <Part part={part} message={message} />
      </DataProvider>
    </DialogProvider>
  ))
}

afterEach(cleanup)

/** The body sits behind the row's own disclosure, closed at rest like every other tool row. */
function open(view: ReturnType<typeof mount>) {
  view.container.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')?.click()
}

describe("a first-party Claxedo tool renders as its own card", () => {
  test("task_create: the Claxedo mark, the verb, the task as a link, its status, and the replay note", () => {
    const view = mount(toolPart("mcp__claxedo__task_create", completed(
      { title: "MCP smoke: created from a session", status: "backlog", intent: "mcp" },
      { task: { id: TASK_ID, number: 5, title: "MCP smoke: created from a session", status: "backlog", parent: null, project: "prj", createdFrom: null }, replayed: true },
    )))
    const card = view.container.querySelector('[data-component="claxedo-tool"]')
    expect(card?.getAttribute("data-tool")).toBe("task_create")
    expect(view.container.querySelector('[data-component="generic-tool"]')).toBeNull()
    expect(view.container.querySelector('.ui-icon[data-icon="claxedo"], use[href="#opencode-icon-claxedo"]')).not.toBeNull()
    expect(view.container.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toBe("Create task")
    const link = view.container.querySelector<HTMLAnchorElement>('a[data-link-kind="task"]')
    expect(link?.getAttribute("href")).toBe(`/tasks/${encodeURIComponent(TASK_ID)}`)
    expect(link?.textContent).toBe("#5 MCP smoke: created from a session")
    expect(view.container.querySelector('[data-slot="claxedo-tool-status"]')?.textContent).toBe("Backlog")
    expect(view.container.querySelector('[data-slot="basic-tool-tool-arg"]')?.textContent).toBe("already existed")
    expect(view.container.querySelector('[data-slot="claxedo-tool-body"]')).toBeNull()
  })

  test("task_start: the preset name, the task link, and the started session as a link in the facts", () => {
    const view = mount(toolPart("mcp__claxedo__task_start", completed(
      { task: TASK_ID, preset: "Alt voice", intent: "mcp" },
      {
        session: { sessionId: "ses_tasks_1", workspaceId: "w" },
        slot: "primary",
        attempt: 1,
        preset: { id: "tpr_1", name: "Alt voice" },
        placement: "local",
        destination: "/repo, with that workspace's own skills and plugins",
        created: true,
      },
    )))
    expect(view.container.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toBe("Start task")
    expect(view.container.querySelector<HTMLAnchorElement>('a[data-link-kind="task"]')?.getAttribute("href")).toBe(`/tasks/${encodeURIComponent(TASK_ID)}`)
    expect(view.container.querySelector('[data-slot="basic-tool-tool-arg"]')?.textContent).toBe("Alt voice")
    open(view)
    const facts = [...view.container.querySelectorAll('[data-slot="claxedo-tool-fact"]')].map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ])
    expect(facts).toEqual([
      ["Session", "MCP tasks smoke"],
      ["Preset", "Alt voice"],
      ["Slot", "primary"],
      ["Attempt", "1"],
      ["Placement", "local"],
      ["Destination", "/repo, with that workspace's own skills and plugins"],
    ])
    expect(view.container.querySelector<HTMLAnchorElement>('a[data-link-kind="session"]')?.getAttribute("href")).toBe("/s/ses_tasks_1")
  })

  test("a task link hands an unmodified click to the surface's navigator and leaves a modified one to the browser", () => {
    const task = vi.fn()
    const view = mount(toolPart("task_create", completed(
      { server: "claxedo", tool: "task_create", arguments: { title: "From codex" } },
      { task: { id: TASK_ID, number: 6, title: "From codex", status: "todo" }, replayed: false },
    )), { task })
    const link = view.container.querySelector<HTMLAnchorElement>('a[data-link-kind="task"]')!
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    link.dispatchEvent(plain)
    expect(task).toHaveBeenCalledWith(TASK_ID)
    expect(plain.defaultPrevented).toBe(true)
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true })
    link.dispatchEvent(modified)
    expect(task).toHaveBeenCalledTimes(1)
    expect(modified.defaultPrevented).toBe(false)
  })

  test("a refused task_start shows the refusal under the tool's own title, with the task linked", () => {
    const view = mount(toolPart("mcp__claxedo__task_start", {
      status: "error",
      input: { task: TASK_ID, preset: "Alt voice", intent: "mcp" },
      error: "Starting a task's session from inside a session needs the account setting that lets agents act on other machines",
      time: { start: 1, end: 2 },
    }))
    const card = view.container.querySelector('[data-kind="tool-error-card"]')
    expect(card).not.toBeNull()
    expect(card?.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toBe("Start task")
    const subtitle = card?.querySelector<HTMLAnchorElement>('a[data-slot="basic-tool-tool-subtitle"]')
    expect(subtitle?.getAttribute("href")).toBe(`/tasks/${encodeURIComponent(TASK_ID)}`)
    open(view)
    expect(card?.textContent).toContain("needs the account setting that lets agents act on other machines")
    expect(card?.textContent).not.toContain("mcp__claxedo__task_start")
  })

  test("a running call shows the verb and what it was asked for, with no body yet", () => {
    const view = mount(toolPart("claxedo_task_create", { status: "running", input: { title: "Fix the clip" }, time: { start: 1 } }))
    expect(view.container.querySelector('[data-component="claxedo-tool"]')?.getAttribute("data-tool")).toBe("task_create")
    expect(view.container.querySelector('[data-slot="basic-tool-tool-title"] [data-component="text-shimmer"]')?.getAttribute("aria-label")).toBe("Create task")
    expect(view.container.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent).toBe("Fix the clip")
    expect(view.container.querySelector('[data-slot="claxedo-tool-body"]')).toBeNull()
  })

  test("task_list: linked rows with status marks and a tail for the rest", () => {
    const tasks = Array.from({ length: 10 }, (_, index) => ({ id: `tsk_${index}`, number: index + 1, title: `Task ${index + 1}`, status: index % 2 ? "done" : "doing" }))
    const view = mount(toolPart("mcp__claxedo__task_list", completed({ intent: "mcp" }, { project: "prj", tasks, nextCursor: null })))
    expect(view.container.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent).toBe("10 tasks")
    open(view)
    const rows = [...view.container.querySelectorAll('[data-slot="claxedo-tool-row"]')]
    expect(rows).toHaveLength(8)
    expect(rows[0]?.querySelector("a")?.getAttribute("href")).toBe("/tasks/tsk_0")
    expect(rows[0]?.querySelector('[data-slot="claxedo-tool-status"]')?.textContent).toBe("In progress")
    expect(view.container.querySelector('[data-slot="claxedo-tool-more"]')?.textContent).toBe("+2 more")
  })

  test("another server's MCP tool keeps the generic row", () => {
    const view = mount(toolPart("mcp__linear__task_create", completed({ title: "x", intent: "mcp" }, "ok")))
    expect(view.container.querySelector('[data-component="claxedo-tool"]')).toBeNull()
    expect(view.container.querySelector('[data-component="generic-tool"]')).not.toBeNull()
  })
})
