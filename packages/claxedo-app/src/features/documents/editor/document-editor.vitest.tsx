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

function selectEditorContents(editor: HTMLElement) {
  editor.focus()
  fireEvent.focus(editor)
  const range = window.document.createRange()
  range.selectNodeContents(editor.querySelector("p")!)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  window.document.dispatchEvent(new Event("selectionchange"))
  fireEvent.mouseUp(editor)
}

afterEach(cleanup)

describe("DocumentEditor", () => {
  test("mounts the established Notion editor shell for supported Markdown", () => {
    const view = render(() => (
      <DocumentEditor document={document("# Plan\n\nStart here.\n")} api={api()} storage={storage()} />
    ))

    expect(view.container.querySelector(".notion-page-shell")).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Document name" })).toHaveClass("notion-title")
    expect(screen.getByRole("textbox", { name: "Document rich editor" })).toHaveClass("tiptap")
  })

  test("opening without editing performs zero writes at the API boundary", () => {
    const client = api()
    render(() => <DocumentEditor document={document("# Plan\n")} api={client} storage={storage()} />)
    expect(client.save).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Edit source" })).not.toBeInTheDocument()
    expect(screen.queryByRole("toolbar", { name: "Document formatting" })).not.toBeInTheDocument()
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

  test("a recheck that cannot reach rich mode says so instead of silently doing nothing", async () => {
    // An empty paragraph round-trips to blank lines that never parse back, so this
    // document can never reach rich mode — the button must not read as broken.
    render(() => <DocumentEditor document={document("# Hello\n\n\n\n## hi\n")} api={api()} storage={storage()} />)
    expect(screen.queryByText(/still source mode/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Try rich mode" }))
    expect(screen.getByText(/still source mode/)).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Document Markdown source" })).toBeInTheDocument()
    // Editing clears the stale verdict so the next recheck speaks for itself.
    fireEvent.input(screen.getByRole("textbox", { name: "Document Markdown source" }), {
      target: { value: "# Hello\n\n## hi\n" },
    })
    expect(screen.queryByText(/still source mode/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Try rich mode" }))
    await waitFor(() => expect(screen.getByLabelText("Rich Markdown editor")).toBeInTheDocument())
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

  test("failed saves stay actionable and Cmd+S plus unmount flush pending edits", async () => {
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
    fireEvent.keyDown(source, { key: "s", metaKey: true })
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
    const rich = screen.getByRole("button", { name: "Try rich mode" })
    expect(name.compareDocumentPosition(rich) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
  })

  test("the header carries no redundant save control and no empty overflow menu", () => {
    render(() => <DocumentEditor document={document("Heading\n=======\n")} api={api()} storage={storage()} />)
    expect(screen.queryByRole("button", { name: "Save now" })).not.toBeInTheDocument()
    expect(screen.queryByText("More")).not.toBeInTheDocument()
    // Autosave is silent while it is working; only failures earn a control.
    expect(screen.getByRole("status")).toHaveTextContent("Ready")
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
  })

  test("Tiptap Markdown formatting serializes through the normal save queue and keeps the rich editor instance", async () => {
    let savedMarkdown = ""
    const save = vi.fn(async (_id: string, request: { displayName: string; markdown: string }) => {
      savedMarkdown = request.markdown
      return { ok: true as const, version: "opaque-v2" }
    })
    render(() => <DocumentEditor document={document("Paragraph\n")} api={api(save)} storage={storage()} />)

    const editor = screen.getByRole("textbox", { name: "Document rich editor" })
    selectEditorContents(editor)
    fireEvent.click(await screen.findByRole("button", { name: "Underline" }))
    fireEvent.keyDown(editor, { key: "s", metaKey: true })
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(savedMarkdown).toBe("++Paragraph++\n")
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"))

    // The save round-trip must not remount the editor.
    expect(screen.getByRole("textbox", { name: "Document rich editor" })).toBe(editor)
    expect(screen.queryByText("Source mode")).not.toBeInTheDocument()
    expect(editor).toHaveTextContent("Paragraph")
  })

  // External-change live-refresh was intentionally removed:
  // an open editor no longer follows on-disk writes, and the next save surfaces a
  // CAS conflict instead of silently reloading. The former "clean external edits
  // refresh in place" and "autosave self-event preserves the source editor" cases
  // exercised that gone behavior, so they were deleted rather than weakened. CAS
  // conflict surfacing is still covered by the conflict tests above.
})
