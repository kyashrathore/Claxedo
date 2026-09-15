import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { TASKS_BOUNDS, type TaskDraft } from "@claxedo/tasks"
import { chooseOption, optionLabels } from "../shared/test-support/host-controls"
import { TaskCreateForm } from "./task-create-form"
import { TasksProseEditor } from "@/app/integrations/tasks/tasks-prose-editor"

vi.mock("@opencode-ai/ui/select", async () => (await import("../shared/test-support/host-controls")).selectDouble())

afterEach(cleanup)

function mount(initial: Partial<TaskDraft> = {}) {
  const [draft, setDraft] = createSignal({
    projectId: "prj_1",
    title: "",
    description: "",
    workspaceId: null,
    parentTaskId: null,
    ...initial,
  })
  const onSubmit = vi.fn()
  const shrinkImage = vi.fn(async () => new Blob([Uint8Array.from([0x52, 0x49, 0x46, 0x46])], { type: "image/webp" }))
  render(() => (
    <TaskCreateForm
      draft={draft()}
      projects={[{ id: "prj_1", label: "Importer" }]}
      proseEditor={TasksProseEditor}
      onDraftChange={setDraft}
      onSubmit={onSubmit}
      onCancel={() => {}}
      shrinkImage={shrinkImage}
    />
  ))
  return { draft, onSubmit, shrinkImage }
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])

function png(name: string, bytes: Uint8Array = PNG) {
  return new File([bytes], name, { type: "image/png" })
}

/** A paste or drop as the form reads it: jsdom builds neither with files, so the transfer is a plain object. */
function transfer(files: File[]) {
  return { files, items: [], types: ["Files"], getData: () => "" }
}

function pasteFiles(files: File[]) {
  fireEvent.paste(screen.getByTestId("task-create-dialog"), { clipboardData: transfer(files) })
}

describe("the New task dialog", () => {
  test("states which project it lands in, and starts in To do", () => {
    mount()

    expect(screen.getByLabelText("Breadcrumb").textContent).toContain("Importer")
    expect(screen.getByTestId("task-create-status").textContent).toContain("To do")
    expect(screen.getByTestId("task-create-project").textContent).toBe("Importer")
  })

  test("offers the two statuses a task can be created in, and carries the choice into the draft", () => {
    const { draft } = mount()

    expect(optionLabels("task-create-status")).toEqual(["Backlog", "To do"])

    chooseOption("task-create-status", "Backlog")

    expect(draft().status).toBe("backlog")
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

  // The draft carries the image as the command will send it, and the thumbnail
  // is rendered from that same string: what is shown is what is sent.
  test("a pasted image lands in the draft as base64 and is shown as a thumbnail that can be removed", async () => {
    const { draft } = mount()

    pasteFiles([png("shot.png")])
    await waitFor(() => expect(draft().attachments).toEqual([{ filename: "shot.png", mime: "image/png", data: "iVBORw==" }]))
    const thumb = screen.getByTestId("task-create-image").querySelector("img")
    expect(thumb?.getAttribute("src")).toBe("data:image/png;base64,iVBORw==")
    expect(thumb?.getAttribute("alt")).toBe("shot.png")

    fireEvent.click(screen.getByLabelText("Remove shot.png"))
    expect(draft().attachments).toEqual([])
    expect(screen.queryByTestId("task-create-image")).toBeNull()
  })

  test("a dropped image and a picked image reach the draft the same way, in the order added", async () => {
    const { draft } = mount()

    fireEvent.drop(screen.getByTestId("task-create-dialog"), { dataTransfer: transfer([png("dropped.png")]) })
    await waitFor(() => expect(draft().attachments?.map((image) => image.filename)).toEqual(["dropped.png"]))

    const picker = screen.getByTestId<HTMLInputElement>("task-create-image-picker")
    Object.defineProperty(picker, "files", { value: [png("picked.png")], configurable: true })
    fireEvent.change(picker)
    await waitFor(() =>
      expect(draft().attachments?.map((image) => image.filename)).toEqual(["dropped.png", "picked.png"]),
    )
  })

  test("a paste that carries no image is left to the field it landed in", () => {
    const { draft } = mount()
    pasteFiles([])
    expect(draft().attachments).toBeUndefined()
  })

  test("a file that is not an image is refused by name, and the images beside it are still taken", async () => {
    const { draft } = mount()

    pasteFiles([new File(["<svg/>"], "diagram.svg", { type: "image/svg+xml" }), png("shot.png")])
    await waitFor(() => expect(draft().attachments?.map((image) => image.filename)).toEqual(["shot.png"]))
    expect(screen.getByTestId("task-create-image-notice").textContent).toContain("diagram.svg")
  })

  test("an oversized image is shrunk through the encoder the form was given", async () => {
    const { draft, shrinkImage } = mount()

    pasteFiles([png("retina.png", new Uint8Array(TASKS_BOUNDS.taskAttachmentMaxBytes + 1))])
    await waitFor(() => expect(draft().attachments).toEqual([{ filename: "retina.webp", mime: "image/webp", data: "UklGRg==" }]))
    expect(shrinkImage).toHaveBeenCalledTimes(1)
  })

  test("the strip stops at the cap and says so", async () => {
    const full = Array.from({ length: TASKS_BOUNDS.taskAttachmentsMax }, (_, index) => ({
      filename: `shot-${index}.png`,
      mime: "image/png",
      data: "iVBORw==",
    }))
    const { draft } = mount({ attachments: full })
    expect(screen.getByTestId("task-create-add-image")).toHaveProperty("disabled", true)

    pasteFiles([png("one-more.png")])
    await waitFor(() => expect(screen.getByTestId("task-create-image-notice").textContent).toContain("up to 6 images"))
    expect(draft().attachments).toHaveLength(TASKS_BOUNDS.taskAttachmentsMax)
  })

  test("a server refusal that names an image is shown under the strip", () => {
    const [draft] = createSignal<TaskDraft>({
      projectId: "prj_1",
      title: "Ship",
      description: "",
      workspaceId: null,
      parentTaskId: null,
      attachments: [{ filename: "shot.png", mime: "image/png", data: "iVBORw==" }],
    })
    render(() => (
      <TaskCreateForm
        draft={draft()}
        projects={[{ id: "prj_1", label: "Importer" }]}
        proseEditor={TasksProseEditor}
        fieldErrors={{ "attachments[0].data": "This value is too long." }}
        onDraftChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    ))
    expect(screen.getByTestId("task-create-images").parentElement?.textContent).toContain("This value is too long.")
  })
})
