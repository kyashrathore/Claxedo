import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"

let activeTab: any
const addFile = vi.fn()
const addReviewWorkspace = vi.fn()
const patchTab = vi.fn()
const diff = vi.fn()
const sendFocusFile = vi.fn()
const toggleReviewWorkspace = vi.fn()
const hasReviewWorkspace = vi.fn()
const activeLayout = vi.fn()
let syncStore: any
const treeCalls: any[] = []

vi.mock("../context/claxedo-layout", () => ({
  useClaxedoLayout: () => ({
    groupTabs: () => ({
      active: () => activeTab,
      addFile,
      addReviewWorkspace,
    }),
    patchTab,
    multiPane: {
      toggleReviewWorkspace,
      hasReviewWorkspace,
      activeLayout,
    },
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

vi.mock("../context/pane-bus", () => ({
  sendFocusFile,
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
  addReviewWorkspace.mockReset()
  addReviewWorkspace.mockReturnValue("review-workspace-created")
  patchTab.mockReset()
  diff.mockReset()
  sendFocusFile.mockReset()
  sendFocusFile.mockReturnValue(0)
  toggleReviewWorkspace.mockReset()
  hasReviewWorkspace.mockReset()
  hasReviewWorkspace.mockReturnValue(false)
  activeLayout.mockReset()
  activeLayout.mockReturnValue(undefined)
})

describe("FileTreeSidebar", () => {
  test("opens a review workspace in normal mode", async () => {
    activeTab = {
      id: "session-1",
      type: "session",
      directory: "/ws",
      sessionId: "ses_0",
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

    expect(toggleReviewWorkspace).toHaveBeenCalledWith("session-1", "/ws", "ses_0", "session")
    await waitFor(() => {
      expect(sendFocusFile).toHaveBeenCalledWith("session-1", "src/app.ts")
    })
    expect(patchTab).not.toHaveBeenCalled()
    expect(addReviewWorkspace).not.toHaveBeenCalled()
    expect(screen.getByText("Files")).toBeInTheDocument()
  })

  test("legacy review mode opens a review workspace instead of patching the old review tab", async () => {
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

    expect(toggleReviewWorkspace).toHaveBeenCalledWith("review-1", "/ws", "ses_1", "session")
    await waitFor(() => {
      expect(sendFocusFile).toHaveBeenCalledWith("review-1", "src/changed.ts")
    })
    expect(addFile).not.toHaveBeenCalled()
    expect(patchTab).not.toHaveBeenCalled()
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

  test("review-workspace mode keeps file opens inside the active review tab", () => {
    activeTab = {
      id: "review-workspace-1",
      type: "review-workspace",
      directory: "/ws",
      sessionId: "ses_3",
    }
    sendFocusFile.mockReturnValue(1)

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

    expect(sendFocusFile).toHaveBeenCalledWith("review-workspace-1", "src/app.ts")
    expect(toggleReviewWorkspace).not.toHaveBeenCalled()
    expect(addFile).not.toHaveBeenCalled()
    expect(patchTab).not.toHaveBeenCalled()
  })

  test("creates a review workspace tab when no tab is active", async () => {
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

    expect(addReviewWorkspace).toHaveBeenCalledWith("/ws", "new", "Review", undefined, "uncommitted")
    await waitFor(() => {
      expect(sendFocusFile).toHaveBeenCalledWith("review-workspace-created", "src/app.ts")
    })
    expect(toggleReviewWorkspace).not.toHaveBeenCalled()
  })
})
