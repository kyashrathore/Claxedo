import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import type { SessionHandoffState, SessionLiveness, Task, TaskSessionLinkView } from "@claxedo/tasks"
import { TaskDetail, groupLinksBySlot } from "@claxedo/tasks/solid"

afterEach(cleanup)

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk_1",
    revision: 2,
    scopeId: "local",
    projectId: "prj_1",
    workspaceId: null,
    parentTaskId: null,
    title: "Ship the importer",
    description: "",
    status: "doing",
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

// The host can only read a handoff out of a session it still has, so anything
// but `live` reports `unknown` whatever was sent to it.
function link(
  attempt: number,
  liveness: SessionLiveness,
  handoff: SessionHandoffState = liveness === "live" ? "sent" : "unknown",
): TaskSessionLinkView {
  return {
    handoff,
    taskId: "tsk_1",
    slot: "primary",
    attempt,
    sessionRef: { sessionId: `ses_${attempt}`, workspaceId: "ws_1" },
    continuedFrom: null,
    presetId: "pre_1",
    presetRevision: 1,
    presetNameAtStart: "Reviewer",
    createdAt: 1,
    liveness,
  }
}

function mount(links: readonly TaskSessionLinkView[], overrides: Partial<Task> = {}) {
  const onStart = vi.fn()
  const onOpenSession = vi.fn()
  const onSendTask = vi.fn()
  render(() => (
    <TaskDetail
      view={{ task: task(overrides), children: [], groups: groupLinksBySlot(links), configuredSlots: ["primary"] }}
      edit={{ title: task(overrides).title, description: "" }}
      dirty={false}
      projectLabel="Importer"
      onEditChange={() => {}}
      onSave={() => {}}
      onDiscard={() => {}}
      onStatusChange={() => {}}
      onOpenSession={onOpenSession}
      onStart={onStart}
      onSendTask={onSendTask}
      onArchive={() => {}}
      onRestore={() => {}}
      subtasks={<div data-testid="subtasks-slot" />}
    />
  ))
  return { onStart, onOpenSession, onSendTask }
}

describe("task detail linked sessions", () => {
  test("a slot with no link offers Start on attempt 1", () => {
    const { onStart } = mount([])

    expect(screen.queryByTestId("task-slot-start-again-primary")).toBeNull()
    fireEvent.click(screen.getByTestId("task-slot-start-primary"))

    expect(onStart).toHaveBeenCalledWith({ slot: "primary", attempt: 1 })
  })

  test("a live slot opens its session and never offers Start again", () => {
    const { onStart, onOpenSession } = mount([link(1, "live")])

    expect(screen.queryByTestId("task-slot-start-again-primary")).toBeNull()
    expect(screen.queryByTestId("task-slot-start-primary")).toBeNull()
    fireEvent.click(screen.getByTestId("task-slot-open-primary"))

    expect(onOpenSession).toHaveBeenCalledWith({ sessionId: "ses_1", workspaceId: "ws_1" })
    expect(onStart).not.toHaveBeenCalled()
  })

  for (const liveness of ["archived", "deleted", "unavailable"] as const) {
    test(`a ${liveness} current session offers Start again on the next attempt`, () => {
      const { onStart } = mount([link(1, liveness)])

      fireEvent.click(screen.getByTestId("task-slot-start-again-primary"))

      expect(onStart).toHaveBeenCalledWith({ slot: "primary", attempt: 2 })
    })
  }

  test("earlier attempts stay as history under the current one", () => {
    mount([link(1, "archived"), link(2, "live")])

    expect(screen.getByTestId("task-slot-liveness-primary-2").textContent).toBe("live")
    expect(screen.getByTestId("task-slot-liveness-primary-1").textContent).toBe("archived")
    expect(screen.queryByTestId("task-slot-start-again-primary")).toBeNull()
  })

  test("a deleted attempt cannot be opened", () => {
    mount([link(1, "deleted")])

    expect(screen.queryByTestId("task-slot-open-attempt-primary-1")).toBeNull()
  })

  test("an archived task offers neither Start nor Start again", () => {
    mount([link(1, "archived")], { archivedAt: 99 })

    expect(screen.getByTestId("task-slot-start-again-primary")).toBeDisabled()
  })

  // The server refuses every Start against an archived task, the recovery one
  // included, so the notice stays and the control it offers cannot be pressed.
  test("an archived task cannot resend the message its live session never got", () => {
    const { onSendTask } = mount([link(1, "live", "pending")], { archivedAt: 99 })

    expect(screen.getByTestId("task-slot-handoff-primary").textContent).toBe("Task not sent yet")
    expect(screen.getByTestId("task-slot-send-primary")).toBeDisabled()
    fireEvent.click(screen.getByTestId("task-slot-send-primary"))
    expect(onSendTask).not.toHaveBeenCalled()
  })
})
