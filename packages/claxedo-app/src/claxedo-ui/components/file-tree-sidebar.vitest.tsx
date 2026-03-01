import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"

let activeTab: any
const addFile = vi.fn()
const patchTab = vi.fn()
const diff = vi.fn()
let syncStore: any
const treeCalls: any[] = []

vi.mock("../context/claxedo-layout", () => ({
  useClaxedoLayout: () => ({
    groupTabs: () => ({
      active: () => activeTab,
      addFile,
    }),
    patchTab,
  }),
}))

vi.mock("@opencode-ai/claxedo-app", () => ({
  useGlobalSDK: () => ({
    client: {
      session: {
        diff,
      },
    },
  }),
  useGlobalSync: () => ({
    child: () => [syncStore],
  }),
}))

vi.mock("./directory-scope", () => ({
  DirectoryScope: (props: any) => <>{props.children}</>,
}))

vi.mock("@opencode-ai/ui/resize-handle", () => ({
  ResizeHandle: () => <div data-testid="resize" />,
}))

vi.mock("@/components/file-tree", () => ({
  default: (props: any) => {
    treeCalls.push(props)
    const files = props.allowed && props.allowed.length > 0 ? props.allowed : ["src/app.ts"]
    return (
      <div data-testid="file-tree">
        {files.map((path: string) => (
          <button data-testid={`file-${path}`} onClick={() => props.onFileClick?.({ path })}>
            {path}
          </button>
        ))}
      </div>
    )
  },
}))

import { FileTreeSidebar } from "./file-tree-sidebar"

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  activeTab = undefined
  syncStore = { message: {} }
  treeCalls.length = 0
  addFile.mockReset()
  patchTab.mockReset()
  diff.mockReset()
})

describe("FileTreeSidebar", () => {
  test("opens file tab in normal mode", () => {
    activeTab = {
      id: "session-1",
      type: "session",
      directory: "/ws",
    }

    render(() => (
      <FileTreeSidebar
        groupId="g-default"
        directory="/ws"
        opened
        width={320}
        mobile={false}
        onResize={() => {}}
        onCollapse={() => {}}
        onCloseMobile={() => {}}
      />
    ))

    fireEvent.click(screen.getByTestId("file-src/app.ts"))

    expect(addFile).toHaveBeenCalledWith("/ws", "src/app.ts", "app.ts")
    expect(patchTab).not.toHaveBeenCalled()
    expect(screen.getByText("Files")).toBeInTheDocument()
  })

  test("review mode shows changed files and focuses diff instead of opening tab", async () => {
    activeTab = {
      id: "review-1",
      type: "review",
      directory: "/ws",
      sessionId: "ses_1",
      reviewMode: "uncommitted",
      reviewFocusVersion: 4,
    }
    diff.mockResolvedValue({
      data: [
        {
          file: "src/changed.ts",
          before: "",
          after: "one\\n",
          additions: 1,
          deletions: 0,
          status: "modified",
        },
      ],
    })

    render(() => (
      <FileTreeSidebar
        groupId="g-default"
        directory="/ws"
        opened
        width={320}
        mobile={false}
        onResize={() => {}}
        onCollapse={() => {}}
        onCloseMobile={() => {}}
      />
    ))

    await waitFor(() => {
      expect(diff).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionID: "ses_1",
          directory: "/ws",
          mode: "uncommitted",
        }),
      )
    })

    await waitFor(() => {
      expect(screen.getByTestId("file-src/changed.ts")).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId("file-src/changed.ts"))

    expect(patchTab).toHaveBeenCalledWith(
      "review-1",
      expect.objectContaining({
        reviewFocusPath: "src/changed.ts",
        reviewFocusVersion: 5,
      }),
    )
    expect(addFile).not.toHaveBeenCalled()
    expect(screen.getByText("Changed files")).toBeInTheDocument()
  })

  test("session-turn mode uses sync message summary diffs without backend fetch", async () => {
    activeTab = {
      id: "review-2",
      type: "review",
      directory: "/ws",
      sessionId: "ses_2",
      reviewMode: "session-turn",
    }
    syncStore = {
      message: {
        ses_2: [
          {
            role: "user",
            summary: {
              diffs: [
                {
                  file: "src/turn.ts",
                  before: "",
                  after: "a\\n",
                  additions: 1,
                  deletions: 0,
                  status: "added",
                },
              ],
            },
          },
        ],
      },
    }

    render(() => (
      <FileTreeSidebar
        groupId="g-default"
        directory="/ws"
        opened
        width={320}
        mobile={false}
        onResize={() => {}}
        onCollapse={() => {}}
        onCloseMobile={() => {}}
      />
    ))

    await waitFor(() => {
      expect(screen.getByTestId("file-src/turn.ts")).toBeInTheDocument()
    })

    expect(diff).not.toHaveBeenCalled()
    expect(screen.getByText("Changed files")).toBeInTheDocument()
  })
})
