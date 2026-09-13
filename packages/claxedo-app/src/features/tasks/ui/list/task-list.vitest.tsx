import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen, within } from "@solidjs/testing-library"
import type { TaskSummary } from "@claxedo/tasks"
import type { TaskDateField } from "../../view-model"
import { TaskList } from "./task-list"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("../shared/test-support/host-controls")).dropdownMenuDouble())

afterEach(cleanup)

const CREATED = Date.parse("2026-03-01T09:00:00Z")
const UPDATED = Date.parse("2026-09-01T09:00:00Z")

function summary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "tsk_1",
    revision: 1,
    scopeId: "local",
    projectId: "prj_1",
    number: 12,
    workspaceId: null,
    parentTaskId: null,
    title: "Ship the importer",
    status: "todo",
    childSetRevision: 0,
    archivedAt: null,
    createdAt: CREATED,
    updatedAt: UPDATED,
    hasDescription: false,
    links: { count: 0 },
    children: { total: 0, done: 0 },
    ...overrides,
  }
}

function mount(dateField: TaskDateField = "updated", tasks: readonly TaskSummary[] = [summary()]) {
  render(() => (
    <TaskList
      tasks={tasks}
      projectName="Demo project"
      dateField={dateField}
      subtaskProgress={(taskId) => tasks.find((task) => task.id === taskId)?.children}
      onSelect={() => {}}
    />
  ))
  return screen.getByTestId("tasks-list-row-tsk_1")
}

/** True when `first` really does precede `second` in the rendered row. */
function precedes(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe("a list row's properties", () => {
  test("leads with the status mark, then the key, then the title", () => {
    const row = mount()
    const mark = within(row).getByRole("img", { name: "To do" })
    const key = within(row).getByText("DP-12")

    expect(precedes(mark, key)).toBe(true)
    expect(precedes(key, within(row).getByText("Ship the importer"))).toBe(true)
  })

  // The row used to name the status only where grouping was off, and the mark
  // it leads with now is the only thing that says it.
  test("the status mark carries its own name", () => {
    const row = mount("updated", [summary({ status: "backlog" })])

    expect(within(row).getByRole("img", { name: "Backlog" })).toBeTruthy()
  })
})

describe("what a row says about its subtasks and its session", () => {
  test("subtask progress is a plain count carrying no glyph", () => {
    mount("updated", [summary({ children: { total: 2, done: 1 } })])

    expect(screen.getByText("1/2").querySelector("svg")).toBeNull()
  })

  test("a task with no subtasks says nothing rather than 0/0", () => {
    mount()

    expect(screen.queryByText("0/0")).toBeNull()
  })

  test("a task with a session carries the rail's own dot, and nothing inside it", () => {
    mount("updated", [summary({ links: { count: 1 } })])

    const mark = screen.getByRole("img", { name: "Has a session" })
    expect(mark.classList.contains("tsk-dot")).toBe(true)
    expect(mark.childElementCount).toBe(0)
  })

  test("a task with no session carries no mark at all", () => {
    mount()

    expect(screen.queryByRole("img", { name: "Has a session" })).toBeNull()
  })
})

describe("the date a row shows", () => {
  test("is the last touch by default, spelled out in full on hover", () => {
    mount("updated")

    expect(screen.getByTitle(new Date(UPDATED).toLocaleString())).toBeTruthy()
  })

  test("is the first one once Display asks for Created", () => {
    mount("created")

    expect(screen.getByTitle(new Date(CREATED).toLocaleString())).toBeTruthy()
  })
})
