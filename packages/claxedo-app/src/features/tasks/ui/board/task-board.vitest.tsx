import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import type { TaskStatus, TaskSummary } from "@claxedo/tasks"
import { TaskBoard } from "./task-board"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("../shared/test-support/host-controls")).dropdownMenuDouble())

afterEach(cleanup)

let minted = 0

function summary(id: string, status: TaskStatus): TaskSummary {
  return {
    id,
    revision: 4,
    scopeId: "local",
    projectId: "prj_1",
    workspaceId: null,
    number: (minted += 1),
    parentTaskId: null,
    title: `Task ${id}`,
    status,
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    hasDescription: false,
    links: { count: 0 },
    children: { total: 0, done: 0 },
  }
}

/**
 * Status lives in the card's actions menu now that the column already names it,
 * so every case that changes status opens the menu first and presses the row it
 * wants.
 */
function openActions(id: string) {
  fireEvent.click(screen.getByTestId(`tasks-board-actions-${id}`))
  return screen.getByTestId(`tasks-board-status-${id}`)
}

function chooseStatus(id: string, label: string) {
  fireEvent.click(within(openActions(id)).getByRole("menuitemradio", { name: label }))
}

function checkedStatus(id: string) {
  return within(openActions(id))
    .getAllByRole("menuitemradio")
    .find((item) => item.getAttribute("aria-checked") === "true")?.textContent
}

function mount(tasks: readonly TaskSummary[]) {
  const onStatusChange = vi.fn()
  const onSelect = vi.fn()
  const onCreate = vi.fn()
  render(() => (
    <TaskBoard
      tasks={tasks}
      projectName="Demo project"
      dateField="updated"
      subtaskProgress={(taskId) => tasks.find((task) => task.id === taskId)?.children}
      onSelect={onSelect}
      onCreate={onCreate}
      onStatusChange={onStatusChange}
    />
  ))
  return { onStatusChange, onSelect, onCreate }
}

describe("task board", () => {
  test("a status change the record does not take leaves the menu showing the record", () => {
    mount([summary("a", "doing")])

    chooseStatus("a", "Done")

    expect(checkedStatus("a")).toBe("In progress")
  })

  test("every status has a column and cards land in theirs", () => {
    mount([summary("a", "todo"), summary("b", "needs_you"), summary("c", "backlog")])

    expect(screen.getByTestId("tasks-board-column-todo").contains(screen.getByTestId("tasks-board-card-a"))).toBe(true)
    expect(screen.getByTestId("tasks-board-column-needs_you").contains(screen.getByTestId("tasks-board-card-b"))).toBe(true)
    expect(screen.getByTestId("tasks-board-column-backlog").contains(screen.getByTestId("tasks-board-card-c"))).toBe(true)
  })

  test("Backlog is the first column and the only other one that can start a task", () => {
    const { onCreate } = mount([summary("a", "todo")])

    const columns = screen.getAllByTestId(/^tasks-board-column-/).map((column) => column.getAttribute("data-testid"))
    expect(columns[0]).toBe("tasks-board-column-backlog")
    expect(screen.queryByTestId("tasks-board-create-doing")).toBeNull()
    expect(screen.queryByTestId("tasks-board-create-done")).toBeNull()

    fireEvent.click(screen.getByTestId("tasks-board-create-backlog"))
    expect(onCreate).toHaveBeenCalledWith("backlog")
    fireEvent.click(screen.getByTestId("tasks-board-create-todo"))
    expect(onCreate).toHaveBeenCalledWith("todo")
  })

  test("a card carries the key a person quotes", () => {
    mount([summary("a", "todo")])

    expect(within(screen.getByTestId("tasks-board-card-a")).getByText(/^DP-\d+$/)).toBeTruthy()
  })

  test("a card says its subtasks as a plain count and its session as the rail's dot", () => {
    const card = { ...summary("a", "todo"), children: { total: 2, done: 1 }, links: { count: 1 } }
    mount([card])

    expect(screen.getByText("1/2").querySelector("svg")).toBeNull()
    const mark = screen.getByRole("img", { name: "Has a session" })
    expect(mark.classList.contains("tsk-dot")).toBe(true)
    expect(mark.childElementCount).toBe(0)
  })

  test("a card with neither subtasks nor a session carries neither mark", () => {
    mount([summary("a", "todo")])

    expect(screen.queryByText("0/0")).toBeNull()
    expect(screen.queryByRole("img", { name: "Has a session" })).toBeNull()
  })

  test("the per-card menu moves a task without any drag, carrying its expected revision", () => {
    const { onStatusChange } = mount([summary("a", "todo")])

    chooseStatus("a", "In progress")

    expect(onStatusChange).toHaveBeenCalledWith({ taskId: "a", revision: 4, status: "doing" })
  })

  test("the menu is a labelled control, so the board is reachable without a pointer", () => {
    mount([summary("a", "todo")])
    openActions("a")

    expect(screen.getByLabelText("Status of Task a").getAttribute("role")).toBe("radiogroup")
  })

  test("opening a card is separate from changing its status", () => {
    const { onSelect, onStatusChange } = mount([summary("a", "todo")])

    fireEvent.click(screen.getByTestId("tasks-board-open-a"))

    expect(onSelect).toHaveBeenCalledWith("a")
    expect(onStatusChange).not.toHaveBeenCalled()
  })

  // The title line is a narrow target on a card that is mostly padding and
  // meta, and a subtask's card is the one most often clicked by its parent's
  // reader. The card itself opens the task.
  test("clicking anywhere on a card opens that task, subtask card included", () => {
    const { onSelect } = mount([{ ...summary("child", "todo"), parentTaskId: "a" }])

    fireEvent.click(screen.getByTestId("tasks-board-card-child"))

    expect(onSelect).toHaveBeenCalledWith("child")
  })

  test("the row tools swallow their own clicks, so a status change never also opens the task", () => {
    const { onSelect, onStatusChange } = mount([summary("a", "todo")])

    chooseStatus("a", "In progress")

    expect(onStatusChange).toHaveBeenCalledWith({ taskId: "a", revision: 4, status: "doing" })
    expect(onSelect).not.toHaveBeenCalled()
  })

  test("an archived card cannot be dragged and its menu is disabled", () => {
    mount([{ ...summary("a", "todo"), archivedAt: 12 }])

    expect(screen.getByTestId("tasks-board-card-a").getAttribute("draggable")).toBe("false")
    for (const item of within(openActions("a")).getAllByRole("menuitemradio")) expect(item).toBeDisabled()
  })
})
