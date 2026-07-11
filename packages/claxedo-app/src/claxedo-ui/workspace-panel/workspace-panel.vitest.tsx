import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, onCleanup, onMount } from "solid-js"
import { WorkspacePanel } from "./workspace-panel"
import type { WorkspacePanelState } from "./workspace-panel-state"

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 })
  window.dispatchEvent(new Event("resize"))
})

function pointerEvent(type: string, clientX: number) {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, "clientX", { value: clientX })
  Object.defineProperty(event, "pointerId", { value: 1 })
  return event
}

const openState: WorkspacePanelState = {
  open: true,
  mode: "review",
  workspaceDir: "/workspace",
  targetPaneId: "pane-session",
}

function renderPanel(state: WorkspacePanelState, input?: {
  fullWidth?: () => boolean
  onClose?: () => void
  onRestingWidthChange?: (width: number) => void
  onShellRef?: (element: HTMLElement | undefined) => void
}) {
  return render(() => (
    <WorkspacePanel
      state={state}
      fullWidth={input?.fullWidth}
      onClose={input?.onClose}
      onRestingWidthChange={input?.onRestingWidthChange}
      onShellRef={input?.onShellRef}
      renderMode={() => <div>workspace body</div>}
    />
  ))
}

describe("WorkspacePanel", () => {
  test("renders the panel shell with the selected workspace tool mounted", () => {
    renderPanel(openState)

    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toBeInTheDocument()
    expect(screen.getByTestId("workspace-panel-shell")).toHaveAttribute("data-open", "true")
    expect(screen.getByText("workspace body")).toBeInTheDocument()
  })

  test("renders navigator-backed shell with the selected workspace tool mounted", () => {
    renderPanel({ ...openState, navigator: "files" })

    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toBeInTheDocument()
    expect(screen.getByText("workspace body")).toBeInTheDocument()
  })

  test("reports the panel shell ref and clears it on cleanup", () => {
    const refs: (HTMLElement | undefined)[] = []
    const view = renderPanel(openState, {
      onShellRef: (element) => refs.push(element),
    })

    expect(refs[0]).toBe(screen.getByTestId("workspace-panel-shell"))

    view.unmount()

    expect(refs.at(-1)).toBeUndefined()
  })

  test("reports resting width through an explicit shell callback", () => {
    const widths: number[] = []

    renderPanel(openState, {
      onRestingWidthChange: (width) => widths.push(width),
    })

    expect(widths.at(-1)).toBeGreaterThanOrEqual(360)
    expect(screen.getByTestId("workspace-panel-shell").style.getPropertyValue("--workspace-panel-width")).toBe(`${widths.at(-1)}px`)
  })

  test("marks the pending files navigator shell ready before rows hydrate", () => {
    render(() => (
      <WorkspacePanel
        state={{ ...openState, navigator: "files" }}
        renderMode={() => undefined}
      />
    ))

    expect(screen.getByTestId("workspace-files-navigator")).toHaveAttribute("data-file-tree-shell-ready", "true")
    expect(screen.getByTestId("workspace-files-navigator")).not.toHaveAttribute("data-file-tree-data-ready")
  })

  test("keeps the selected workspace tool warm-mounted when closed", async () => {
    const view = renderPanel({ ...openState, open: false })

    expect(screen.queryByRole("complementary", { name: "Workspace panel" })).not.toBeInTheDocument()
    expect(screen.queryByRole("separator", { name: "Resize workspace panel" })).not.toBeInTheDocument()
    expect(await screen.findByText("workspace body")).toBeInTheDocument()
    expect(view.container.textContent).toContain("workspace body")
  })

  test("close and reopen do not remount the selected workspace tool", async () => {
    let mounts = 0
    let cleanups = 0
    const Body = () => {
      onMount(() => {
        mounts++
      })
      onCleanup(() => {
        cleanups++
      })
      return <div>workspace body</div>
    }
    const [state, setState] = createSignal(openState)

    render(() => (
      <WorkspacePanel
        state={state()}
        renderMode={() => <Body />}
      />
    ))

    await waitFor(() => expect(mounts).toBe(1))
    setState({ ...openState, open: false })
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)
    setState(openState)
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)
  })

  test("rapid close and reopen keeps the selected workspace tool mounted", async () => {
    let mounts = 0
    let cleanups = 0
    const Body = () => {
      onMount(() => {
        mounts++
      })
      onCleanup(() => {
        cleanups++
      })
      return <div>workspace body</div>
    }
    const [state, setState] = createSignal(openState)

    render(() => (
      <WorkspacePanel
        state={state()}
        renderMode={() => <Body />}
      />
    ))

    await waitFor(() => expect(mounts).toBe(1))
    setState({ ...openState, open: false })
    setState(openState)
    setState({ ...openState, open: false })
    setState(openState)

    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toHaveAttribute("data-open", "true")
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)
  })

  test("rapid reopen cancels the stale close exposure cleanup", () => {
    vi.useFakeTimers()
    const [state, setState] = createSignal(openState)

    render(() => (
      <WorkspacePanel
        state={state()}
        renderMode={() => <div>workspace body</div>}
      />
    ))

    setState({ ...openState, open: false })
    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toHaveAttribute("data-open", "false")
    setState(openState)
    vi.advanceTimersByTime(200)

    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toHaveAttribute("data-open", "true")
    expect(screen.getByText("workspace body")).toBeInTheDocument()
  })

  test("opening the navigator does not remount the selected workspace tool", async () => {
    let mounts = 0
    let cleanups = 0
    const Body = () => {
      onMount(() => {
        mounts++
      })
      onCleanup(() => {
        cleanups++
      })
      return <div>workspace body</div>
    }
    const [state, setState] = createSignal(openState)

    render(() => (
      <WorkspacePanel
        state={state()}
        renderMode={() => <Body />}
      />
    ))

    await waitFor(() => expect(mounts).toBe(1))
    setState({ ...openState, navigator: "files" })
    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toHaveStyle({ width: "716px" })
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)
  })

  test("stable content identity keeps the body mounted across mode changes", async () => {
    let mounts = 0
    let cleanups = 0
    const Body = () => {
      onMount(() => {
        mounts++
      })
      onCleanup(() => {
        cleanups++
      })
      return <div>workspace body</div>
    }
    const [state, setState] = createSignal(openState)

    render(() => (
      <WorkspacePanel
        state={state()}
        contentIdentity={(state) => ({
          targetPaneId: state.targetPaneId,
          workspaceDir: state.workspaceDir,
        })}
        renderMode={() => <Body />}
      />
    ))

    await waitFor(() => expect(mounts).toBe(1))
    setState({ ...openState, mode: "files", navigator: "files" })
    expect(screen.getByText("workspace body")).toBeInTheDocument()
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)
  })

  test("renders the body when a cached workspace later receives its mode", async () => {
    let renders = 0
    const [state, setState] = createSignal<WorkspacePanelState>({
      open: false,
      workspaceDir: "/workspace",
      targetPaneId: "pane-session",
    })

    render(() => (
      <WorkspacePanel
        state={state()}
        contentIdentity={(state) => ({
          targetPaneId: state.targetPaneId,
          workspaceDir: state.workspaceDir,
        })}
        renderMode={() => {
          renders += 1
          return <div>workspace body</div>
        }}
      />
    ))

    expect(screen.queryByText("workspace body")).not.toBeInTheDocument()

    setState(openState)

    await waitFor(() => expect(screen.getByText("workspace body")).toBeInTheDocument())
    expect(renders).toBe(1)
  })

  test("does not expose an internal mode switcher", () => {
    renderPanel(openState)

    expect(screen.queryByRole("button", { name: "Files" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument()
  })

  test("does not render a floating close action", () => {
    const onClose = vi.fn()
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 480 })
    renderPanel(openState, { onClose })

    expect(screen.queryByRole("button", { name: "Close workspace panel" })).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  test("opens toward seventy percent while preserving readable content width", () => {
    renderPanel(openState)

    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toHaveStyle({ width: "716px" })
  })

  test("navigator overlays without changing the panel width", () => {
    renderPanel({ ...openState, navigator: "files" })

    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toHaveStyle({ width: "716px" })
  })

  test("full-width prop drives panel width without remounting the body", async () => {
    let mounts = 0
    let cleanups = 0
    const Body = () => {
      onMount(() => {
        mounts++
      })
      onCleanup(() => {
        cleanups++
      })
      return <div>workspace body</div>
    }
    const [fullWidth, setFullWidth] = createSignal(false)

    render(() => (
      <WorkspacePanel
        state={openState}
        fullWidth={fullWidth}
        renderMode={() => <Body />}
      />
    ))

    await waitFor(() => expect(mounts).toBe(1))
    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toHaveStyle({ width: "716px" })
    setFullWidth(true)
    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toHaveStyle({ width: "1024px" })
    setFullWidth(false)
    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toHaveStyle({ width: "716px" })
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)
  })

  test("resizes from the left edge handle", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 })
    renderPanel(openState)

    const panel = screen.getByRole("complementary", { name: "Workspace panel" })
    const handle = screen.getByRole("separator", { name: "Resize workspace panel" })

    fireEvent(handle, pointerEvent("pointerdown", 500))
    window.dispatchEvent(pointerEvent("pointermove", 400))
    window.dispatchEvent(pointerEvent("pointerup", 400))

    expect(panel).toHaveStyle({ width: "1107px" })
  })

  test("exposes ARIA splitter value range and resizes via the keyboard", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 })
    renderPanel(openState)

    const panel = screen.getByRole("complementary", { name: "Workspace panel" })
    const handle = screen.getByRole("separator", { name: "Resize workspace panel" })

    expect(handle).toHaveAttribute("aria-valuemin", "360")
    expect(handle).toHaveAttribute("aria-valuemax", "1140")
    expect(handle).toHaveAttribute("aria-valuenow", "1007")

    // ArrowLeft widens the right-anchored panel by one step.
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(panel).toHaveStyle({ width: "1031px" })
    expect(handle).toHaveAttribute("aria-valuenow", "1031")

    // ArrowRight narrows it back.
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(panel).toHaveStyle({ width: "1007px" })

    // Home / End jump to the min / max width.
    fireEvent.keyDown(handle, { key: "Home" })
    expect(panel).toHaveStyle({ width: "360px" })
    fireEvent.keyDown(handle, { key: "End" })
    expect(panel).toHaveStyle({ width: "1140px" })
  })

  test("uses a full-width sheet without a resize handle on mobile", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 })

    renderPanel(openState)

    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toHaveStyle({ width: "100%" })
    expect(screen.queryByRole("separator", { name: "Resize workspace panel" })).not.toBeInTheDocument()
  })
})
