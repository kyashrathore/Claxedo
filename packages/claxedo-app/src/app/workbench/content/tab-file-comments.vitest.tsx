import { flush } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"

const h = vi.hoisted(() => ({
  fileRead: vi.fn(async () => ({ data: { content: "one\ntwo\nthree\nfour" } })),
  commentsList: vi.fn(() => []),
  commentsAdd: vi.fn(() => ({ id: "comment-1" })),
  commentsUpdate: vi.fn(),
  commentsRemove: vi.fn(),
  promptAdd: vi.fn(),
  promptUpdateComment: vi.fn(),
  promptRemoveComment: vi.fn(),
  controllerInput: undefined as
    | {
        onSubmit: (input: { comment: string; selection: { start: number; end: number } }) => void
        onUpdate: (input: { id: string; comment: string; selection: { start: number; end: number } }) => void
        onDelete: (comment: { id: string }) => void
      }
    | undefined,
  fileProps: undefined as
    | {
        enableLineSelection?: boolean
        enableGutterUtility?: boolean
        file?: { contents: string }
      }
    | undefined,
}))

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => ({
    url: "http://127.0.0.1:4096",
    workspaceId: "ws_repo",
    directory: "/repo",
    event: { listen: () => () => {} },
    client: {
      file: {
        read: h.fileRead,
      },
    },
  }),
}))

vi.mock("@/platform/comments/provider", () => ({
  useComments: () => ({
    list: h.commentsList,
    add: h.commentsAdd,
    update: h.commentsUpdate,
    remove: h.commentsRemove,
  }),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock("@/features/session/providers/prompt", () => ({
  usePrompt: () => ({
    context: {
      add: h.promptAdd,
      updateComment: h.promptUpdateComment,
      removeComment: h.promptRemoveComment,
    },
  }),
}))

vi.mock("@/ui/session-kit", () => ({
  createLineCommentController: (input: typeof h.controllerInput) => {
    h.controllerInput = input
    return {
      annotations: () => [],
      renderAnnotation: () => null,
      renderGutterUtility: () => null,
      onLineSelected: vi.fn(),
      onLineNumberSelectionEnd: vi.fn(),
      onLineSelectionEnd: vi.fn(),
    }
  },
  File: (props: typeof h.fileProps) => {
    h.fileProps = props
    return <div data-testid="file-viewer">{props?.file?.contents}</div>
  },
  Markdown: (props: { text: string }) => <div>{props.text}</div>,
}))

vi.mock("@opencode-ai/ui/file-icon", () => ({
  FileIcon: () => <span />,
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: { onClick?: () => void; "aria-label"?: string }) => (
    <button aria-label={props["aria-label"]} onClick={props.onClick} />
  ),
}))

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: { children: unknown }) => <>{props.children}</>,
}))

import { TabFile } from "./tab-file"
import { setFileHeaderActionsSlot } from "@/ui/controls/portal-slot"
import { clearFileRequestCache } from "@/platform/files/file-request-cache"

describe("TabFile comments", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", undefined)
  })

  afterEach(() => {
    cleanup()
    clearFileRequestCache()
    setFileHeaderActionsSlot(null)
    vi.unstubAllGlobals()
    h.fileRead.mockClear()
    h.commentsList.mockClear()
    h.commentsAdd.mockClear()
    h.commentsUpdate.mockClear()
    h.commentsRemove.mockClear()
    h.promptAdd.mockClear()
    h.promptUpdateComment.mockClear()
    h.promptRemoveComment.mockClear()
    h.controllerInput = undefined
    h.fileProps = undefined
  })

  test("line comments in file tabs are added to the composer context", async () => {
    const view = render(() => <TabFile path="/repo/src/app.ts" hideHeader />)

    await waitFor(() => expect(h.fileRead).toHaveBeenCalledWith({ path: "/repo/src/app.ts" }))
    await waitFor(() => expect(h.fileProps?.file?.contents).toBe("one\ntwo\nthree\nfour"))
    expect(view.getByTestId("tab-file-root")).toHaveAttribute("data-tab-file-path", "/repo/src/app.ts")
    expect(view.getByTestId("tab-file-root")).toHaveAttribute("data-tab-file-state", "ready")
    expect(h.fileProps?.enableLineSelection).toBe(true)
    expect(h.fileProps?.enableGutterUtility).toBe(true)

    h.controllerInput?.onSubmit({
      comment: "check this branch",
      selection: { start: 2, end: 3 },
    })

    expect(h.commentsAdd).toHaveBeenCalledWith({
      file: "/repo/src/app.ts",
      selection: { start: 2, end: 3 },
      comment: "check this branch",
    })
    expect(h.promptAdd).toHaveBeenCalledWith({
      type: "file",
      path: "/repo/src/app.ts",
      selection: {
        startLine: 2,
        endLine: 3,
        startChar: 0,
        endChar: 0,
      },
      comment: "check this branch",
      commentID: "comment-1",
      commentOrigin: "file",
      preview: "two\nthree",
    })
  })

  test("file-tab comment edits and deletes update composer context", async () => {
    render(() => <TabFile path="/repo/src/app.ts" hideHeader />)

    await waitFor(() => expect(h.controllerInput).toBeDefined())
    // …and wait for the file text as well: the comment preview is sliced out of
    // it, and the controller is wired before the read resolves.
    await waitFor(() => expect(h.fileProps?.file?.contents).toBe("one\ntwo\nthree\nfour"))
    // Editing a comment and deleting it are two separate user actions, each its
    // own task in the app; Solid 2 would otherwise coalesce them into one flush
    // and the delete would read the state from before the edit.
    h.controllerInput?.onUpdate({
      id: "comment-1",
      comment: "new note",
      selection: { start: 3, end: 3 },
    })
    flush()
    h.controllerInput?.onDelete({ id: "comment-1" })
    flush()

    expect(h.commentsUpdate).toHaveBeenCalledWith("/repo/src/app.ts", "comment-1", "new note")
    expect(h.promptUpdateComment).toHaveBeenCalledWith("/repo/src/app.ts", "comment-1", {
      comment: "new note",
      preview: "three",
    })
    expect(h.commentsRemove).toHaveBeenCalledWith("/repo/src/app.ts", "comment-1")
    expect(h.promptRemoveComment).toHaveBeenCalledWith("/repo/src/app.ts", "comment-1")
  })

  test("file header copies the workspace-relative path from a subdued action", async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const view = render(() => <TabFile path="/repo/docs/readme.md" onCollaborate={() => {}} />)

    const add = view.getByRole("button", { name: "Add to Documents" })
    const copy = view.getByRole("button", { name: "Copy relative path" })

    expect(add.getAttribute("data-icon-interaction")).toBe("subdued")
    expect(copy.getAttribute("data-icon-interaction")).toBe("subdued")

    fireEvent.click(copy)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("docs/readme.md"))
    // The label flips after the clipboard promise resolves, i.e. past the flush
    // the click itself triggered, so this one has to wait for the next.
    expect(await view.findByRole("button", { name: "Copied relative path" })).toBeTruthy()
  })

  test("portaled file header exposes copy path for non-Markdown files", async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const view = render(() => (
      <>
        <div ref={setFileHeaderActionsSlot} />
        <TabFile path="/repo/docs/readme.md" hideHeader headerActive={false} onCollaborate={() => {}} />
        <TabFile path="/repo/assets/mark.svg" hideHeader headerActive />
      </>
    ))

    expect(view.queryByRole("button", { name: "Add to Documents" })).toBeNull()
    expect(view.getAllByRole("button", { name: "Copy relative path" })).toHaveLength(1)
    fireEvent.click(view.getByRole("button", { name: "Copy relative path" }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("assets/mark.svg"))
  })

  test("binary images render an inline preview", async () => {
    h.fileRead.mockResolvedValueOnce({
      data: { type: "binary", content: "aW1hZ2U=", encoding: "base64", mimeType: "application/octet-stream" },
    })
    const view = render(() => <TabFile path="assets/photo.png" hideHeader />)

    const image = await view.findByRole("img", { name: "photo.png" })
    expect(image.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=")
    expect(view.queryByTestId("file-viewer")).toBeNull()
  })

  test("reuses a runtime-scoped file read when the active tab remounts", async () => {
    const first = render(() => <TabFile path="/repo/src/app.ts" hideHeader />)
    await first.findByTestId("file-viewer")
    first.unmount()

    const second = render(() => <TabFile path="/repo/src/app.ts" hideHeader />)
    await second.findByTestId("file-viewer")

    expect(h.fileRead).toHaveBeenCalledTimes(1)
  })
})
