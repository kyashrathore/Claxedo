import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"

const activeLayout = vi.fn()
const hasReviewWorkspace = vi.fn()
const toggleReviewWorkspace = vi.fn()
const getBound = vi.fn()
const dispatch = vi.fn()
const sendFocusFile = vi.fn()
const autoBind = vi.fn()
const peersWithCapability = vi.fn(() => [])
const unbind = vi.fn()
const usePane = vi.fn()

vi.mock("../../context/claxedo-layout", () => ({
  useClaxedoLayout: () => ({
    multiPane: {
      activeLayout,
      hasReviewWorkspace,
      toggleReviewWorkspace,
    },
  }),
}))

vi.mock("../../context/pane-bus", () => ({
  autoBind,
  dispatch,
  getBound,
  peersWithCapability,
  sendFocusFile,
  unbind,
  usePane,
}))

vi.mock("@/components/file-tree", () => ({
  default: (props: any) => (
    <button data-testid="file-src/app.ts" onClick={() => props.onFileClick?.({ path: "src/app.ts" })}>
      src/app.ts
    </button>
  ),
}))

import { FileTreePane } from "./file-tree-pane"

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  activeLayout.mockReset()
  activeLayout.mockReturnValue(undefined)
  hasReviewWorkspace.mockReset()
  hasReviewWorkspace.mockReturnValue(false)
  toggleReviewWorkspace.mockReset()
  getBound.mockReset()
  getBound.mockReturnValue(null)
  dispatch.mockReset()
  dispatch.mockReturnValue(false)
  sendFocusFile.mockReset()
  sendFocusFile.mockReturnValue(0)
  autoBind.mockReset()
  peersWithCapability.mockClear()
  unbind.mockReset()
  usePane.mockReset()
})

describe("FileTreePane", () => {
  test("dispatches directly to a bound review target", () => {
    getBound.mockReturnValue("review-leaf")
    dispatch.mockReturnValue(true)

    render(() => (
      <FileTreePane directory="/ws" tabId="tab-1" leafId="files-1" groupId="g-1" />
    ))

    fireEvent.click(screen.getByTestId("file-src/app.ts"))

    expect(dispatch).toHaveBeenCalledWith("review-leaf", {
      type: "review:focus-file",
      payload: { path: "src/app.ts" },
    })
    expect(toggleReviewWorkspace).not.toHaveBeenCalled()
  })

  test("opens the review workspace when no review target exists", async () => {
    activeLayout.mockReturnValue({
      contents: {
        a: { type: "session", directory: "/ws", sessionId: "ses_1" },
      },
    })

    render(() => (
      <FileTreePane directory="/ws" tabId="tab-1" leafId="files-1" groupId="g-1" />
    ))

    fireEvent.click(screen.getByTestId("file-src/app.ts"))

    expect(toggleReviewWorkspace).toHaveBeenCalledWith("tab-1", "/ws", "ses_1", "session")
    await waitFor(() => {
      expect(sendFocusFile).toHaveBeenCalledWith("tab-1", "src/app.ts")
    })
  })
})
