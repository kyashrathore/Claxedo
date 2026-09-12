import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import type { TaskStatus, TaskSummary } from "@claxedo/tasks"
import { TaskBoard } from "@claxedo/tasks/solid"

afterEach(cleanup)

function summary(id: string, status: TaskStatus): TaskSummary {
  return {
    id,
    revision: 4,
    scopeId: "local",
    projectId: "prj_1",
    workspaceId: null,
    parentTaskId: null,
    title: `Task ${id}`,
    status,
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    hasDescription: false,
  }
}

function mount(tasks: readonly TaskSummary[]) {
  const onStatusChange = vi.fn()
  const onSelect = vi.fn()
  render(() => <TaskBoard tasks={tasks} onSelect={onSelect} onStatusChange={onStatusChange} />)
  return { onStatusChange, onSelect }
}

describe("task board", () => {
  test("every status has a column and cards land in theirs", () => {
    mount([summary("a", "todo"), summary("b", "needs_you")])

    expect(screen.getByTestId("tasks-board-column-todo").contains(screen.getByTestId("tasks-board-card-a"))).toBe(true)
    expect(screen.getByTestId("tasks-board-column-needs_you").contains(screen.getByTestId("tasks-board-card-b"))).toBe(true)
  })

  test("the per-card menu moves a task without any drag, carrying its expected revision", () => {
    const { onStatusChange } = mount([summary("a", "todo")])

    fireEvent.change(screen.getByTestId("tasks-board-status-a"), { target: { value: "doing" } })

    expect(onStatusChange).toHaveBeenCalledWith({ taskId: "a", revision: 4, status: "doing" })
  })

  test("the menu is a labelled control, so the board is reachable without a pointer", () => {
    mount([summary("a", "todo")])

    expect(screen.getByLabelText("Status of Task a").tagName).toBe("SELECT")
  })

  test("opening a card is separate from changing its status", () => {
    const { onSelect, onStatusChange } = mount([summary("a", "todo")])

    fireEvent.click(screen.getByTestId("tasks-board-open-a"))

    expect(onSelect).toHaveBeenCalledWith("a")
    expect(onStatusChange).not.toHaveBeenCalled()
  })

  test("an archived card cannot be dragged and its menu is disabled", () => {
    mount([{ ...summary("a", "todo"), archivedAt: 12 }])

    expect(screen.getByTestId("tasks-board-card-a").getAttribute("draggable")).toBe("false")
    expect(screen.getByTestId("tasks-board-status-a")).toBeDisabled()
  })
})
