import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { primaryConfiguration, presetRow, taskRow } from "@claxedo/tasks/test-support"
import { taskSummaryOf, type Preset, type TaskSummary } from "@claxedo/tasks"
import { TaskStartControl, type StartChoice, type TaskStartOffer } from "./task-row-controls"

vi.mock("@opencode-ai/ui/dropdown-menu", async () => (await import("./test-support/host-controls")).dropdownMenuDouble())

afterEach(cleanup)

function summary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  const row = taskRow({ id: "tsk_1", revision: 3, number: 1, title: "Ship the importer" })
  return { ...taskSummaryOf(row, { count: 0 }, { total: 0, done: 0 }), ...overrides }
}

function preset(id: string, name: string, slots: readonly ("planning" | "review")[] = []): Preset {
  const configuration = primaryConfiguration({ model: { providerID: "anthropic", modelID: "opus" } })
  return presetRow({
    id,
    revision: 2,
    name,
    configurations: {
      primary: configuration,
      ...Object.fromEntries(slots.map((slot) => [slot, configuration])),
    },
  })
}

function mount(input: { task?: TaskSummary } & Partial<TaskStartOffer> = {}) {
  const { task, ...offer } = input
  const onStart = vi.fn<(choice: StartChoice) => void>()
  const onOpenPresetSettings = vi.fn()
  render(() => (
    <TaskStartControl
      task={task ?? summary()}
      testIdPrefix="tasks-list"
      offer={{
        presets: [preset("pre_1", "Careful reviewer")],
        defaultPresetId: "pre_1",
        onStart,
        onOpenPresetSettings,
        ...offer,
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

  test("a control that belongs to one slot offers each preset once, for that slot", () => {
    const { onStart } = mount({ slot: "review", presets: [preset("pre_1", "Careful reviewer", ["review"])] })

    fireEvent.click(screen.getByTestId("tasks-list-start-tsk_1"))
    expect(onStart).toHaveBeenCalledWith({ presetId: "pre_1", slot: "review" })

    fireEvent.click(screen.getByTestId("tasks-list-start-menu-tsk_1"))
    expect(screen.getByTestId("tasks-list-start-tsk_1-pre_1-review")).toBeTruthy()
    expect(screen.queryByTestId("tasks-list-start-tsk_1-pre_1-primary")).toBeNull()
  })

  test("a slot no preset configures says so rather than claiming there are none saved", () => {
    mount({ slot: "planning", presets: [] })

    fireEvent.click(screen.getByTestId("tasks-list-start-menu-tsk_1"))

    expect(screen.getByText("No preset configures Planning yet.")).toBeTruthy()
  })

  test("the main part carries the word the caller gave it", () => {
    mount({ startLabel: "Start again" })

    const control = screen.getByTestId("tasks-list-start-tsk_1")
    expect(control.textContent).toBe("Start again")
    expect(control.getAttribute("aria-label")).toBe("Start again Ship the importer")
  })

  test("the caret carries the previous session where there is one to continue from", () => {
    const onContinue = vi.fn()
    mount({ slot: "primary", startLabel: "Start again", onContinue })

    fireEvent.click(screen.getByTestId("tasks-list-start-menu-tsk_1"))
    fireEvent.click(screen.getByTestId("tasks-list-continue-tsk_1"))

    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  test("a slot with nothing to continue from offers no continue", () => {
    mount({ slot: "primary" })

    fireEvent.click(screen.getByTestId("tasks-list-start-menu-tsk_1"))

    expect(screen.queryByTestId("tasks-list-continue-tsk_1")).toBeNull()
  })

  test("an archived task can neither be started nor offered alternatives", () => {
    mount({ task: summary({ archivedAt: 99 }) })

    expect(screen.getByTestId<HTMLButtonElement>("tasks-list-start-tsk_1").disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>("tasks-list-start-menu-tsk_1").disabled).toBe(true)
  })
})
