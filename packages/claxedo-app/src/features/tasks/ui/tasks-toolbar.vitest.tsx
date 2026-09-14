import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createTasksStore } from "../store/tasks-store"
import { chooseOption, optionLabels } from "./shared/test-support/host-controls"
import { TasksToolbar } from "./tasks-toolbar"

vi.mock("@opencode-ai/ui/select", async () => (await import("./shared/test-support/host-controls")).selectDouble())

afterEach(cleanup)

function mount() {
  const store = createTasksStore()
  render(() => (
    <TasksToolbar store={store} projects={[{ id: "prj_1", label: "Demo project" }]} projectId="prj_1" />
  ))
  fireEvent.click(screen.getByTestId("tasks-display"))
  return store
}

describe("the Display popover's date option", () => {
  test("offers the task's two timestamps and starts on the last touch", () => {
    const store = mount()

    expect(optionLabels("tasks-date-field")).toEqual(["Updated", "Created"])
    expect(store.state.dateField).toBe("updated")
  })

  test("the choice is the store's, so the rows and the cards read the same one", () => {
    const store = mount()

    chooseOption("tasks-date-field", "Created")

    expect(store.state.dateField).toBe("created")
  })
})
