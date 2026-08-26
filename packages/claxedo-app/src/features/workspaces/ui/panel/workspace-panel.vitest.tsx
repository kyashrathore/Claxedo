import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { WorkspacePanel } from "./workspace-panel"
import type { WorkspacePanelState } from "./workspace-panel-state"

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}))

vi.mock("@/platform/api/api", () => ({
  api: apiMocks,
  getDefaultBaseUrl: () => "http://test.local",
  normalizeUrl: (value: string | undefined) => value?.replace(/\/+$/, ""),
}))

vi.mock("@/features/workspaces/app-ports", () => ({
  emitTerminalFit: vi.fn(),
}))

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 })
  window.dispatchEvent(new Event("resize"))
  apiMocks.get.mockReset()
  apiMocks.post.mockReset()
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

  test("shows cloud lifecycle identity, checkpoint, and registered worktrees", async () => {
    apiMocks.get.mockResolvedValue({
      lease: {
        sandboxId: "sandbox-1",
        driver: "cloudflare",
        epoch: 3,
        status: "ready",
      },
      checkpoint: {
        id: "cp_3",
        sourceEpoch: 3,
        capturedAt: 1,
        metadata: { scope: "directories", restoreMount: "copy-on-write" },
      },
      capabilities: { capture: "directories", resume: "replacement-restore" },
      runtime: { version: "0.6.0", image: "runtime:0.6.0" },
      worktrees: [{ sessionId: "session-1", branch: "claxedo/session/session-1", state: "active" }],
    })

    renderPanel({ ...openState, workspaceDir: "workspace:ws_cloud" })

    await waitFor(() => expect(screen.getByText("cloudflare · epoch 3")).toBeInTheDocument())
    fireEvent.click(screen.getByText("Cloud workspace"))
    expect(screen.getByText("sandbox-1")).toBeInTheDocument()
    expect(screen.getByText(/cp_3 · epoch 3/)).toBeInTheDocument()
    expect(screen.getByText(/claxedo\/session\/session-1/)).toBeInTheDocument()
  })

  test("requires confirmation and sends approval for destructive cloud lifecycle operations", async () => {
    apiMocks.get.mockResolvedValue({
      lease: { sandboxId: "sandbox-1", driver: "vercel", epoch: 2, status: "ready" },
      checkpoint: {
        id: "cp_2",
        sourceEpoch: 2,
        capturedAt: 1,
        metadata: { scope: "filesystem", restoreMount: "new-resource" },
      },
      capabilities: { capture: "filesystem", resume: "replacement-restore" },
      worktrees: [],
    })
    apiMocks.post.mockResolvedValue({})
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true)

    renderPanel({ ...openState, workspaceDir: "workspace:ws_cloud" })
    await waitFor(() => expect(screen.getByText("vercel · epoch 2")).toBeInTheDocument())
    fireEvent.click(screen.getByText("Cloud workspace"))
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }))

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith(
      "http://test.local/api/workspace/ws_cloud/lifecycle/replace",
      { approved: true, checkpointId: "cp_2" },
    ))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("current sandbox will be discarded"))
    confirm.mockRestore()
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

  test("does not mount a selected workspace tool while initially closed", () => {
    const renderMode = vi.fn(() => <div>workspace body</div>)
    const view = render(() => (
      <WorkspacePanel
        state={{ ...openState, open: false }}
        renderMode={renderMode}
      />
    ))

    expect(screen.queryByRole("complementary", { name: "Workspace panel" })).not.toBeInTheDocument()
    expect(screen.queryByRole("separator", { name: "Resize workspace panel" })).not.toBeInTheDocument()
    expect(screen.queryByText("workspace body")).not.toBeInTheDocument()
    expect(view.container.textContent).not.toContain("workspace body")
    expect(renderMode).not.toHaveBeenCalled()
  })

  test("disposes the selected workspace tool after close motion and restores it on reopen", async () => {
    vi.useFakeTimers()
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

    expect(mounts).toBe(1)
    setState({ ...openState, open: false })
    expect(screen.getByText("workspace body")).toBeInTheDocument()
    expect(cleanups).toBe(0)

    vi.advanceTimersByTime(141)

    expect(screen.queryByText("workspace body")).not.toBeInTheDocument()
    expect(cleanups).toBe(1)

    setState(openState)
    expect(screen.getByText("workspace body")).toBeInTheDocument()
    expect(mounts).toBe(2)
    expect(cleanups).toBe(1)
  })

  test("deactivates resources immediately and preserves focus intent across a completed close", () => {
    vi.useFakeTimers()
    const focus = { kind: "file", path: "src/preserved.ts", intent: "tab", version: 7 } as const
    const activeStates: boolean[] = []
    const renderedFocusPaths: (string | undefined)[] = []
    const [state, setState] = createSignal<WorkspacePanelState>({ ...openState, focus })

    const Body = (props: { active: () => boolean; focusPath?: string }) => {
      renderedFocusPaths.push(props.focusPath)
      createEffect(() => activeStates.push(props.active()))
      return <div>workspace body</div>
    }

    render(() => (
      <WorkspacePanel
        state={state()}
        renderMode={(_mode, panelState, active) => (
          <Body
            active={active}
            focusPath={panelState.focus?.kind === "file" ? panelState.focus.path : undefined}
          />
        )}
      />
    ))

    expect(activeStates.at(-1)).toBe(true)
    setState({ ...openState, focus, open: false })
    expect(activeStates.at(-1)).toBe(false)

    vi.advanceTimersByTime(141)
    expect(screen.queryByText("workspace body")).not.toBeInTheDocument()

    setState({ ...openState, focus })
    expect(activeStates.at(-1)).toBe(true)
    expect(renderedFocusPaths).toEqual(["src/preserved.ts", "src/preserved.ts"])
  })

  test("restores body scroll and in-panel focus after remount", async () => {
    vi.useFakeTimers()
    const [state, setState] = createSignal(openState)

    render(() => (
      <WorkspacePanel
        state={state()}
        renderMode={() => (
          <div data-testid="restored-scroll" class="overflow-auto">
            <button type="button">Preserved focus</button>
            <div style={{ height: "1000px" }} />
          </div>
        )}
      />
    ))

    const initialScroll = screen.getByTestId("restored-scroll")
    initialScroll.scrollTop = 84
    screen.getByRole("button", { name: "Preserved focus" }).focus()

    setState({ ...openState, open: false })
    vi.advanceTimersByTime(141)
    expect(screen.queryByTestId("restored-scroll")).not.toBeInTheDocument()

    setState(openState)
    await Promise.resolve()

    expect(screen.getByTestId("restored-scroll").scrollTop).toBe(84)
    expect(screen.getByRole("button", { name: "Preserved focus" })).toHaveFocus()
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
