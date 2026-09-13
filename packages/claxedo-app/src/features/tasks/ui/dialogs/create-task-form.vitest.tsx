import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import type { TaskDraft } from "@claxedo/tasks"
import { TaskCreateForm } from "./task-create-form"
import { TasksProseEditor } from "@/app/integrations/tasks/tasks-prose-editor"

vi.mock("@opencode-ai/ui/select", async () => (await import("../shared/test-support/host-controls")).selectDouble())

afterEach(cleanup)

function mount() {
  const [draft, setDraft] = createSignal<TaskDraft>({
    projectId: "prj_1",
    title: "",
    description: "",
    workspaceId: null,
    parentTaskId: null,
  })
  const onSubmit = vi.fn()
  render(() => (
    <TaskCreateForm
      draft={draft()}
      projects={[{ id: "prj_1", label: "Importer" }]}
      proseEditor={TasksProseEditor}
      onDraftChange={setDraft}
      onSubmit={onSubmit}
      onCancel={() => {}}
    />
  ))
  return { draft, onSubmit }
}

describe("the New task dialog", () => {
  test("states what a new task will be, and which project it lands in", () => {
    mount()

    expect(screen.getByLabelText("Breadcrumb").textContent).toContain("Importer")
    expect(screen.getByTestId("task-create-dialog").textContent).toContain("To do")
    expect(screen.getByTestId("task-create-project").textContent).toBe("Importer")
  })

  // The dialog writes the same records the task page edits, so what it stores
  // has to be the same markdown string and not the editor's own shape.
  test("a description written here is submitted as markdown", async () => {
    const { draft, onSubmit } = mount()

    fireEvent.input(screen.getByTestId("task-create-title"), { target: { value: "Ship the importer" } })
    const body = await waitFor(() => {
      const found = screen.getByTestId("task-create-description").querySelector<HTMLElement>(".tiptap")
      if (!found) throw new Error("the description editor never mounted")
      return found
    })
    // The editor commits markdown on every change; this is the shape a heading
    // typed through its shortcuts arrives in.
    fireEvent.input(body, { target: { innerHTML: "<h2>Plan</h2>" } })
    await waitFor(() => expect(draft().description).toContain("## Plan"))

    fireEvent.click(screen.getByTestId("task-create-submit"))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(draft().title).toBe("Ship the importer")
    expect(draft().description.trim()).toBe("## Plan")
  })
})
