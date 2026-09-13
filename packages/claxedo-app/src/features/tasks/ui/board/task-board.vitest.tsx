import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import type { TaskStatus, TaskSummary } from "@claxedo/tasks"
import { TaskBoard } from "./task-board"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("../shared/test-support/host-controls")).dropdownMenuDouble())

afterEach(cleanup)

function summary(id: string, status: TaskStatus): TaskSummary {
  return {
    id,
    revision: 4,
    scopeId: "local",
    projectId: "prj_1",
    workspaceId: null,
    number: 1,
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
  render(() => <TaskBoard tasks={tasks} onSelect={onSelect} onStatusChange={onStatusChange} />)
  return { onStatusChange, onSelect }
}

describe("task board", () => {
  test("a status change the record does not take leaves the menu showing the record", () => {
    mount([summary("a", "doing")])

    chooseStatus("a", "Done")

    expect(checkedStatus("a")).toBe("In progress")
  })

  test("every status has a column and cards land in theirs", () => {
    mount([summary("a", "todo"), summary("b", "needs_you")])

    expect(screen.getByTestId("tasks-board-column-todo").contains(screen.getByTestId("tasks-board-card-a"))).toBe(true)
    expect(screen.getByTestId("tasks-board-column-needs_you").contains(screen.getByTestId("tasks-board-card-b"))).toBe(true)
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
