import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import type { Preset, TaskSummary } from "@claxedo/tasks"
import { TaskStartControl, type StartChoice } from "./task-row-controls"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("./test-support/host-controls")).dropdownMenuDouble())

afterEach(cleanup)

function summary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "tsk_1",
    revision: 3,
    scopeId: "local",
    projectId: "prj_1",
    workspaceId: null,
    parentTaskId: null,
    title: "Ship the importer",
    status: "todo",
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    hasDescription: false,
    links: { count: 0 },
    ...overrides,
  }
}

function preset(id: string, name: string, slots: readonly ("planning" | "review")[] = []): Preset {
  const configuration = {
    harness: { id: "claude", access: "native" as const },
    model: { providerID: "anthropic", modelID: "opus" },
    effort: null,
  }
  return {
    id,
    revision: 2,
    scopeId: "local",
    ownerId: "owner",
    name,
    instructions: "",
    execution: { placement: "local", capabilities: { mode: "inherit-local" } },
    configurations: {
      primary: configuration,
      ...Object.fromEntries(slots.map((slot) => [slot, configuration])),
    },
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function mount(input: {
  task?: TaskSummary
  presets?: readonly Preset[]
  defaultPresetId?: string
  blocker?: string
  onOpen?: () => void
}) {
  const onStart = vi.fn<(choice: StartChoice) => void>()
  const onOpenPresetSettings = vi.fn()
  render(() => (
    <TaskStartControl
      task={input.task ?? summary()}
      testIdPrefix="tasks-list"
      offer={{
        presets: input.presets ?? [preset("pre_1", "Careful reviewer")],
        defaultPresetId: input.defaultPresetId ?? "pre_1",
        blocker: input.blocker,
        onStart,
        ...(input.onOpen ? { onOpen: input.onOpen } : {}),
        onOpenPresetSettings,
      }}
    />
  ))
  return { onStart, onOpenPresetSettings }
}

describe("starting a task from its row", () => {
  test("the main part starts the primary slot with the default preset", () => {
    const { onStart } = mount({ presets: [preset("pre_1", "Careful reviewer"), preset("pre_2", "Alt voice")], defaultPresetId: "pre_2" })

    fireEvent.click(screen.getByTestId("tasks-list-start-tsk_1"))

    expect(onStart).toHaveBeenCalledWith({ presetId: "pre_2", slot: "primary" })
  })

  test("the caret offers every preset, and a configuration for one that has more than Primary", () => {
    const { onStart } = mount({ presets: [preset("pre_1", "Careful reviewer", ["review"])] })

    fireEvent.click(screen.getByTestId("tasks-list-start-menu-tsk_1"))
    fireEvent.click(screen.getByTestId("tasks-list-start-tsk_1-pre_1-review"))

    expect(onStart).toHaveBeenCalledWith({ presetId: "pre_1", slot: "review" })
  })

  // The count says a session exists; which one is current is a detail read, so
  // the row hands Open back to its caller rather than naming a session itself.
  test("a task that already has a session offers Open in place of Start", () => {
    const onOpen = vi.fn()
    const { onStart } = mount({ task: summary({ links: { count: 2 } }), onOpen })

    expect(screen.queryByTestId("tasks-list-start-tsk_1")).toBeNull()
    fireEvent.click(screen.getByTestId("tasks-list-open-session-tsk_1"))

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
  })

  test("with no preset saved the menu sends the user to Settings and starts nothing", () => {
    const { onStart, onOpenPresetSettings } = mount({ presets: [], defaultPresetId: undefined })

    expect(screen.getByTestId<HTMLButtonElement>("tasks-list-start-tsk_1").disabled).toBe(true)
    fireEvent.click(screen.getByTestId("tasks-list-start-menu-tsk_1"))
    fireEvent.click(screen.getByTestId("tasks-list-preset-settings-tsk_1"))

    expect(onOpenPresetSettings).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
  })

  test("a refused start is reported in the menu it was started from", () => {
    mount({ blocker: "sonnet is not connected here." })

    fireEvent.click(screen.getByTestId("tasks-list-start-menu-tsk_1"))

    expect(screen.getByTestId("tasks-list-start-blocker-tsk_1").textContent).toBe("sonnet is not connected here.")
  })

  test("an archived task can neither be started nor offered alternatives", () => {
    mount({ task: summary({ archivedAt: 99 }) })

    expect(screen.getByTestId<HTMLButtonElement>("tasks-list-start-tsk_1").disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>("tasks-list-start-menu-tsk_1").disabled).toBe(true)
  })
})
