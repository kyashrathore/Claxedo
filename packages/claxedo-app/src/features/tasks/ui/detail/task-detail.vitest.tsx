import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import type { SessionHandoffState, SessionLiveness, Task, TaskSessionLinkView } from "@claxedo/tasks"
import { groupLinksBySlot } from "../../view-model"
import { TaskDetail } from "./task-detail"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("../shared/test-support/host-controls")).dropdownMenuDouble())

afterEach(cleanup)

const StubProseEditor = (props: {
  value: string
  testId: string
  ariaLabel: string
  placeholder: string
  onChange: (value: string) => void
}) => (
  <textarea
    data-testid={props.testId}
    aria-label={props.ariaLabel}
    placeholder={props.placeholder}
    value={props.value}
    onInput={(event) => props.onChange(event.currentTarget.value)}
  />
)

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk_1",
    revision: 2,
    scopeId: "local",
    projectId: "prj_1",
    workspaceId: null,
    number: 1,
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
      proseEditor={StubProseEditor}
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

/**
 * A subtask page, as the panel composes it: the parent's own read supplies the
 * title, and the subtasks section is absent rather than present and empty,
 * because subtasks are one level deep.
 */
function mountSubtask(input: { onOpenParent?: () => void } = {}) {
  render(() => (
    <TaskDetail
      view={{
        task: task({ id: "tsk_child", title: "Write the importer test", parentTaskId: "tsk_1" }),
        parent: { id: "tsk_1", title: "Ship the importer" },
        children: [],
        groups: [],
        configuredSlots: ["primary"],
      }}
      edit={{ title: "Write the importer test", description: "" }}
      dirty={false}
      proseEditor={StubProseEditor}
      projectLabel="Importer"
      onEditChange={() => {}}
      onSave={() => {}}
      onDiscard={() => {}}
      onStatusChange={() => {}}
      onOpenSession={() => {}}
      onStart={() => {}}
      onSendTask={() => {}}
      onArchive={() => {}}
      onRestore={() => {}}
      onOpenParent={input.onOpenParent}
    />
  ))
}

describe("the key a task page names itself by", () => {
  test("closes the breadcrumb, and stands nowhere else", () => {
    mount([])

    const key = screen.getByTestId("task-detail-key")
    expect(key.textContent).toBe("IMP-1")
    expect(screen.getByLabelText("Breadcrumb").contains(key)).toBe(true)
    expect(screen.getAllByText("IMP-1")).toHaveLength(1)
  })
})

describe("the properties rail", () => {
  test("each row is its own value, named for a reader rather than by a label beside it", () => {
    mount([link(1, "live")], { workspaceId: "ws_1" })

    const rail = screen.getByLabelText("Properties")
    // The menu the control opens carries the same name, so the trigger is
    // reached by its test id and its own label read off it.
    const status = within(rail).getByTestId("task-detail-status")
    expect(status.getAttribute("aria-label")).toBe("Status")
    expect(status.textContent).toContain("In progress")
    expect(within(rail).getByLabelText("Project").textContent).toBe("Importer")
    expect(within(rail).getByLabelText("Preset").textContent).toBe("Reviewer")
    expect(within(rail).getByLabelText("Workspace").textContent).toBe("ws_1")
  })

  test("names no property twice, because the row is the value", () => {
    mount([link(1, "live")], { workspaceId: "ws_1" })

    const rail = screen.getByLabelText("Properties")
    for (const label of ["Status", "Project", "Preset", "Workspace"]) {
      expect(within(rail).queryByText(label)).toBeNull()
    }
  })
})

describe("a subtask's own page", () => {
  test("names the task it belongs to, and opens it", () => {
    const onOpenParent = vi.fn()
    mountSubtask({ onOpenParent })

    expect(screen.getByTestId("task-detail-parent-tag").textContent).toBe("Subtask of Ship the importer")
    fireEvent.click(screen.getByTestId("task-detail-parent-crumb"))

    expect(onOpenParent).toHaveBeenCalledTimes(1)
  })

  test("carries the parent in the breadcrumb chain", () => {
    mountSubtask({ onOpenParent: () => {} })

    const crumbs = screen.getByLabelText("Breadcrumb").textContent ?? ""
    expect(crumbs).toContain("Ship the importer")
    expect(crumbs).toContain("Write the importer test")
  })

  test("shows no subtasks section at all, not an empty one", () => {
    mountSubtask()

    expect(screen.queryByTestId("task-subtasks")).toBeNull()
    expect(screen.queryByText("Subtasks")).toBeNull()
    expect(screen.queryByText("No subtasks yet.")).toBeNull()
    expect(screen.queryByText("Subtasks are one level deep.")).toBeNull()
  })
})

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
