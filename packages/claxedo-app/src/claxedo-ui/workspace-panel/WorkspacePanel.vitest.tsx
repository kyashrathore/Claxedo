import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { WorkspacePanel } from "./WorkspacePanel"
import type { WorkspacePanelState } from "./workspace-panel-state"

afterEach(() => {
  cleanup()
})

function pointerEvent(type: string, clientX: number) {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, "clientX", { value: clientX })
  Object.defineProperty(event, "pointerId", { value: 1 })
  return event
}

const openState: WorkspacePanelState = {
  open: true,
  mode: "files",
  workspaceDir: "/workspace",
  targetPaneId: "pane-session",
  tabs: [{ id: "review", type: "review" }],
  activeTabId: "review",
}

describe("WorkspacePanel", () => {
  test("renders the selected workspace tool", () => {
    render(() => (
      <WorkspacePanel
        state={openState}
        renderMode={(mode) => <div>{mode} body</div>}
      />
    ))

    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toBeInTheDocument()
    expect(screen.getByText("files body")).toBeInTheDocument()
  })

  test("does not render when closed", () => {
    const view = render(() => (
      <WorkspacePanel
        state={{ ...openState, open: false }}
        renderMode={(mode) => <div>{mode} body</div>}
      />
    ))

    expect(view.container.textContent).toBe("")
  })

  test("does not expose an internal mode switcher", () => {
    const onModeSelect = vi.fn()
    render(() => (
      <WorkspacePanel
        state={openState}
        onModeSelect={onModeSelect}
        renderMode={(mode) => <div>{mode} body</div>}
      />
    ))

    expect(screen.queryByRole("button", { name: "Files" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument()
    expect(onModeSelect).not.toHaveBeenCalled()
  })

  test("closes from the hover action", async () => {
    const onClose = vi.fn()
    render(() => (
      <WorkspacePanel
        state={openState}
        onClose={onClose}
        renderMode={(mode) => <div>{mode} body</div>}
      />
    ))

    await fireEvent.click(screen.getByRole("button", { name: "Close workspace panel" }))

    expect(onClose).toHaveBeenCalled()
  })

  test("adds navigator width instead of taking review width", () => {
    render(() => (
      <WorkspacePanel
        state={{ ...openState, navigator: "files" }}
        renderMode={(mode) => <div>{mode} body</div>}
      />
    ))

    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toHaveStyle({ width: "760px" })
  })

  test("resizes from the left edge handle", async () => {
    render(() => (
      <WorkspacePanel
        state={openState}
        renderMode={(mode) => <div>{mode} body</div>}
      />
    ))

    const panel = screen.getByRole("complementary", { name: "Workspace panel" })
    const handle = screen.getByRole("separator", { name: "Resize workspace panel" })

    fireEvent(handle, pointerEvent("pointerdown", 500))
    window.dispatchEvent(pointerEvent("pointermove", 400))
    window.dispatchEvent(pointerEvent("pointerup", 400))

    expect(panel).toHaveStyle({ width: "620px" })
  })
})
