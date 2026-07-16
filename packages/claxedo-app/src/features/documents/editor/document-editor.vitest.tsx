import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import DocumentEditor from "./document-editor"
import type { DocumentSummary, DocumentsApi, OpenDocument } from "../data/documents-api"
import type { RecoveryDraftStorage } from "../state/recovery-draft"

const summary = {
  id: "doc-1",
  project_id: "project-1",
  display_name: "Plan",
  origin_kind: "managed",
  placement_kind: "local",
  placement_id: "local",
  managed_relative_path: "documents/project-1/doc-1/plan.md",
  repository_id: null,
  workspace_id: null,
  repository_relative_path: null,
  branch: null,
  status: "draft",
  session_id: null,
  archived_at: null,
  created_at: "now",
  updated_at: "now",
  last_opened_at: null,
  last_known_file_version: "opaque-v1",
} satisfies DocumentSummary

function document(markdown: string): OpenDocument {
  return { id: "doc-1", displayName: "Plan", markdown, version: "opaque-v1", modifiedAt: 1, summary }
}

function storage(): RecoveryDraftStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

function api(save = vi.fn(async () => ({ ok: true as const, version: "opaque-v2" }))) {
  return {
    save,
    create: vi.fn(async () => summary),
  } satisfies Pick<DocumentsApi, "save" | "create">
}

afterEach(cleanup)

describe("DocumentEditor", () => {
  test("opening without editing performs zero writes at the API boundary", () => {
    const client = api()
    render(() => <DocumentEditor document={document("# Plan\n")} api={client} storage={storage()} />)
    expect(client.save).not.toHaveBeenCalled()
    expect(screen.getByRole("toolbar", { name: "Document formatting" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "improve" })).toBeDisabled()
  })

  test("labels source mode with the detector reason and saves plain Markdown on blur", async () => {
    const client = api()
    render(() => <DocumentEditor document={document("Heading\n=======\n")} api={client} storage={storage()} />)
    expect(screen.getByText("Source mode")).toBeInTheDocument()
    expect(screen.getByText(/Setext headings/)).toBeInTheDocument()
    const source = screen.getByRole("textbox", { name: "Document Markdown source" })
    fireEvent.input(source, { target: { value: "Heading\n=======\nchanged" } })
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes")
    fireEvent.blur(source)
    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        "doc-1",
        expect.objectContaining({ markdown: "Heading\n=======\nchanged" }),
      ),
    )
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"))
  })

  test("source to rich requires a successful explicit recheck action", async () => {
    render(() => <DocumentEditor document={document("Heading\n=======\n")} api={api()} storage={storage()} />)
    const source = screen.getByRole("textbox", { name: "Document Markdown source" })
    fireEvent.input(source, { target: { value: "# Heading\n" } })
    expect(screen.getByText("Source mode")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Try rich mode" }))
    await waitFor(() => expect(screen.getByLabelText("Rich Markdown editor")).toBeInTheDocument())
  })

  test("rich to source is an explicit transition over the same Markdown draft", async () => {
    render(() => <DocumentEditor document={document("# Heading\n")} api={api()} storage={storage()} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }))
    expect(screen.getByText("Source mode")).toBeInTheDocument()
    expect(screen.getByText(/selected for direct Markdown editing/)).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Document Markdown source" })).toHaveValue("# Heading\n")
  })

  test("conflict preserves compare, reload, save-copy, and confirmed overwrite actions", async () => {
    const save = vi.fn(async () => ({
      ok: false as const,
      kind: "conflict" as const,
      currentVersion: "opaque-v2",
      current: { displayName: "Disk", markdown: "disk" },
    }))
    const client = api(save)
    render(() => <DocumentEditor document={document("Heading\n=======\n")} api={client} storage={storage()} />)
    const source = screen.getByRole("textbox", { name: "Document Markdown source" })
    fireEvent.input(source, { target: { value: "human" } })
    fireEvent.blur(source)
    await screen.findByText("Document changed on disk")
    expect(screen.getByRole("button", { name: "Reload disk" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save as copy" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Overwrite" })).toBeInTheDocument()
    fireEvent.click(screen.getByText("Compare versions"))
    expect(screen.getByLabelText("Your draft")).toHaveTextContent("human")
    expect(screen.getByLabelText("Current disk version")).toHaveTextContent("disk")
    fireEvent.click(screen.getByRole("button", { name: "Save as copy" }))
    await waitFor(() =>
      expect(client.create).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "Plan copy", markdown: "human" }),
      ),
    )
    fireEvent.click(screen.getByRole("button", { name: "Reload disk" }))
    expect(screen.getByRole("textbox", { name: "Document rich editor" })).toHaveTextContent("disk")
  })

  test("failed and saving states stay visible and confirmed overwrite retries against disk version", async () => {
    let resolveSave!: (value: {
      ok: false
      kind: "conflict"
      currentVersion: string
      current: { displayName: string; markdown: string }
    }) => void
    const first = new Promise<Parameters<typeof resolveSave>[0]>((resolve) => {
      resolveSave = resolve
    })
    const save = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ ok: true, version: "opaque-v3" })
    render(() => <DocumentEditor document={document("Heading\n=======\n")} api={api(save)} storage={storage()} />)
    const source = screen.getByRole("textbox", { name: "Document Markdown source" })
    fireEvent.input(source, { target: { value: "human" } })
    fireEvent.blur(source)
    expect(screen.getByRole("status")).toHaveTextContent("Saving")
    resolveSave({
      ok: false,
      kind: "conflict",
      currentVersion: "opaque-v2",
      current: { displayName: "Disk", markdown: "disk" },
    })
    await screen.findByText("Document changed on disk")
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }))
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        "doc-1",
        expect.objectContaining({ expectedVersion: "opaque-v2", markdown: "human" }),
      ),
    )
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"))
  })

  test("failed saves stay actionable and Save now plus unmount flush pending edits", async () => {
    const failed = api(
      vi.fn(async () => {
        throw new Error("read only")
      }),
    )
    const view = render(() => (
      <DocumentEditor document={document("Heading\n=======\n")} api={failed} storage={storage()} />
    ))
    const source = screen.getByRole("textbox", { name: "Document Markdown source" })
    fireEvent.input(source, { target: { value: "pending" } })
    fireEvent.click(screen.getByRole("button", { name: "Save now" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Save failed"))
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    view.unmount()

    const saved = api()
    const closing = render(() => (
      <DocumentEditor document={document("Heading\n=======\n")} api={saved} storage={storage()} />
    ))
    fireEvent.input(screen.getByRole("textbox", { name: "Document Markdown source" }), {
      target: { value: "close flush" },
    })
    closing.unmount()
    await waitFor(() =>
      expect(saved.save).toHaveBeenCalledWith("doc-1", expect.objectContaining({ markdown: "close flush" })),
    )
  })

  test("persistence controls have predictable keyboard order and a live status region", () => {
    render(() => <DocumentEditor document={document("Heading\n=======\n")} api={api()} storage={storage()} />)
    const name = screen.getByRole("textbox", { name: "Document name" })
    const save = screen.getByRole("button", { name: "Save now" })
    const rich = screen.getByRole("button", { name: "Try rich mode" })
    expect(name.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(save.compareDocumentPosition(rich) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
  })

  test("accepted selection transforms flow through the editor update into the normal save queue", async () => {
    const client = api()
    const transformSelection = vi.fn(async () => "Improved paragraph")
    render(() => (
      <DocumentEditor
        document={document("Paragraph\n")}
        api={client}
        storage={storage()}
        transformSelection={transformSelection}
      />
    ))
    const editor = screen.getByRole("textbox", { name: "Document rich editor" })
    editor.focus()
    fireEvent.focus(editor)
    const range = window.document.createRange()
    range.selectNodeContents(editor.querySelector("p")!)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    window.document.dispatchEvent(new Event("selectionchange"))
    fireEvent.mouseUp(editor)

    fireEvent.click(screen.getByRole("button", { name: "improve" }))

    await waitFor(() => expect(transformSelection).toHaveBeenCalledWith("improve", "Paragraph"))
    await waitFor(() => expect(editor).toHaveTextContent("Improved paragraph"))
    fireEvent.focusOut(screen.getByLabelText("Rich Markdown editor"))
    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith(
        "doc-1",
        expect.objectContaining({ markdown: "Improved paragraph\n" }),
      ),
    )
  })

  test("clean external edits refresh in place while dirty edits enter the normal conflict flow", async () => {
    let onEvent: ((event: { type: "document.changed"; document_id: string }) => void) | undefined
    let disk = document("# Initial\n")
    const client = {
      ...api(),
      open: vi.fn(async () => disk),
      watch: vi.fn(async (_query, next: typeof onEvent, signal?: AbortSignal) => {
        onEvent = next
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
      }),
    }
    render(() => <DocumentEditor document={disk} api={client} storage={storage()} />)
    await waitFor(() => expect(client.open).toHaveBeenCalled())

    disk = { ...disk, markdown: "# External clean\n", version: "opaque-v2" }
    onEvent?.({ type: "document.changed", document_id: "doc-1" })
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Document rich editor" })).toHaveTextContent("External clean"),
    )

    fireEvent.click(screen.getByRole("button", { name: "Edit source" }))
    fireEvent.input(screen.getByRole("textbox", { name: "Document Markdown source" }), {
      target: { value: "human draft" },
    })
    disk = { ...disk, markdown: "external again", version: "opaque-v3" }
    onEvent?.({ type: "document.changed", document_id: "doc-1" })
    await screen.findByText("Document changed on disk")
    expect(screen.getByLabelText("Your draft")).toHaveTextContent("human draft")
    expect(screen.getByLabelText("Current disk version")).toHaveTextContent("external again")
  })
})
