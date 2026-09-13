import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { TasksProseEditor } from "@/app/integrations/tasks/tasks-prose-editor"
import { detectMarkdown } from "@/features/documents/markdown/detector"

afterEach(cleanup)

function mount(initial: string) {
  const [value, setValue] = createSignal(initial)
  const onChange = vi.fn((next: string) => setValue(next))
  render(() => (
    <TasksProseEditor
      value={value()}
      placeholder="Add a description…"
      ariaLabel="Task description"
      testId="task-detail-description"
      onChange={onChange}
    />
  ))
  return { value, setValue, onChange }
}

const RICH = "# Importer\n\nWhat it does:\n\n- reads the file\n- writes the rows\n"

describe("a Tasks markdown field", () => {
  test("renders the description as markdown, not as its source", async () => {
    mount(RICH)

    const field = await waitFor(() => screen.getByTestId("task-detail-description"))
    expect(field.getAttribute("data-prose-mode")).toBe("rich")
    await waitFor(() => expect(field.querySelector("h1")?.textContent).toBe("Importer"))
    expect(field.querySelectorAll("li")).toHaveLength(2)
    // The heading is a heading, not the two characters that spell one.
    expect(field.textContent).not.toContain("# Importer")
    expect(field.textContent).not.toContain("- reads the file")
  })

  test("the body it edits is the stored markdown, and what it hands back is markdown too", async () => {
    const { onChange } = mount(RICH)

    const field = await waitFor(() => screen.getByTestId("task-detail-description"))
    const body = field.querySelector<HTMLElement>(".tiptap")
    expect(body).not.toBeNull()
    // Editing in place: the rendered body is the editable surface, so there is
    // no read-mode to leave before typing.
    expect(body?.getAttribute("contenteditable")).toBe("true")
    expect(onChange).not.toHaveBeenCalled()
  })

  // The detector is a byte-exact gate. Text it cannot re-serialize unchanged
  // must not reach an editor that would rewrite it.
  test("text the detector classifies source falls back to the textarea", () => {
    mount("a line\r\nwith CRLF endings\r\n")

    const field = screen.getByTestId<HTMLTextAreaElement>("task-detail-description")
    expect(field.tagName).toBe("TEXTAREA")
    expect(field.querySelector(".tiptap")).toBeNull()
    // `textarea.value` is specified to normalize CRLF, so the text is what is
    // asserted here; that the bytes reach the store unchanged is the point of
    // NOT mounting the editor, which the tag above is the evidence for.
    expect(field.value).toContain("with CRLF endings")
  })

  /**
   * Documents refuses `* item` because saving it back would rewrite the user's
   * bytes as `- item`. A task description is the app's own record, so that
   * rewrite is acceptable and the field opens rich instead of falling back to
   * a textarea for a bullet.
   */
  test("markdown the serializer would normalize still opens rich here", async () => {
    mount("* item")

    const field = await waitFor(() => screen.getByTestId("task-detail-description"))
    expect(field.getAttribute("data-prose-mode")).toBe("rich")
    await waitFor(() => expect(field.querySelectorAll("li")).toHaveLength(1))
  })

  test("the fallback still edits the record as markdown", () => {
    const { onChange } = mount("a line\r\nwith CRLF endings\r\n")

    fireEvent.input(screen.getByTestId("task-detail-description"), { target: { value: "# rewritten" } })

    expect(onChange).toHaveBeenCalledWith("# rewritten")
  })

  /**
   * A refetch, a rebase or a discard replaces the description with text the
   * field never saw. Admitting it on the strength of the first value would
   * hand `RichMode` an HTML comment it drops on `setContent`, and the next
   * keystroke would save that loss.
   */
  test("a replacement the extensions cannot hold drops the field to the textarea", async () => {
    const { setValue } = mount(RICH)

    await waitFor(() => expect(screen.getByTestId("task-detail-description").getAttribute("data-prose-mode")).toBe("rich"))
    setValue("keep <!-- x --> this\n")

    const field = await waitFor(() => screen.getByTestId<HTMLTextAreaElement>("task-detail-description"))
    expect(field.tagName).toBe("TEXTAREA")
    expect(field.value).toBe("keep <!-- x --> this\n")
  })

  /**
   * `{token}` is outside the rich contract, so re-running the detector over
   * what the editor itself just wrote would take the field away mid-sentence.
   */
  test("what the field itself emits keeps the surface it was typed into", async () => {
    const { value } = mount(RICH)

    const field = await waitFor(() => screen.getByTestId("task-detail-description"))
    field.querySelector("p")!.textContent = "a {token} here"
    fireEvent.input(field.querySelector<HTMLElement>(".tiptap")!)

    await waitFor(() => expect(value()).toContain("{token}"))
    expect(detectMarkdown(value(), "normalizing").status).toBe("source")
    expect(screen.getByTestId("task-detail-description").getAttribute("data-prose-mode")).toBe("rich")
  })

  test("an empty description offers the placeholder to write into", () => {
    mount("")

    const field = screen.getByTestId("task-detail-description")
    expect(field.textContent).toContain("Press '/' for commands")
  })
})
