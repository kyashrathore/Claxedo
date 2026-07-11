import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, waitFor } from "@solidjs/testing-library"

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

vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    client: {
      file: {
        read: h.fileRead,
      },
    },
  }),
}))

vi.mock("@/context/comments", () => ({
  useComments: () => ({
    list: h.commentsList,
    add: h.commentsAdd,
    update: h.commentsUpdate,
    remove: h.commentsRemove,
  }),
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock("@/context/prompt", () => ({
  usePrompt: () => ({
    context: {
      add: h.promptAdd,
      updateComment: h.promptUpdateComment,
      removeComment: h.promptRemoveComment,
    },
  }),
}))

vi.mock("@/session-client", () => ({
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

describe("TabFile comments", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", undefined)
  })

  afterEach(() => {
    cleanup()
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
    render(() => <TabFile path="/repo/src/app.ts" hideHeader />)

    await waitFor(() => expect(h.fileRead).toHaveBeenCalledWith({ path: "/repo/src/app.ts" }))
    await waitFor(() => expect(h.fileProps?.file?.contents).toBe("one\ntwo\nthree\nfour"))
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
    h.controllerInput?.onUpdate({
      id: "comment-1",
      comment: "new note",
      selection: { start: 3, end: 3 },
    })
    h.controllerInput?.onDelete({ id: "comment-1" })

    expect(h.commentsUpdate).toHaveBeenCalledWith("/repo/src/app.ts", "comment-1", "new note")
    expect(h.promptUpdateComment).toHaveBeenCalledWith("/repo/src/app.ts", "comment-1", {
      comment: "new note",
      preview: undefined,
    })
    expect(h.commentsRemove).toHaveBeenCalledWith("/repo/src/app.ts", "comment-1")
    expect(h.promptRemoveComment).toHaveBeenCalledWith("/repo/src/app.ts", "comment-1")
  })
})
