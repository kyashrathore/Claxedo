import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, onCleanup, onMount } from "solid-js"
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

/**
 * How the panel marks one body host. The displayed body carries no hiding
 * marker at all (absence is the canonical exposed state); a retained one
 * carries exactly the triple the perf harness's retained-inert reader proves
 * (`session-switch-workspace-contract.ts`), plus `inert` for interaction.
 */
function panelBodyState(text: string) {
  const host = screen.getByText(text).closest<HTMLElement>("[data-testid='workspace-panel-body']")
  if (!host) throw new Error(`no workspace-panel-body host around "${text}"`)
  return {
    inertMarker: host.getAttribute("data-panel-body-inert"),
    ariaHidden: host.getAttribute("aria-hidden"),
    contentVisibility: host.style.getPropertyValue("content-visibility"),
    inert: host.inert === true,
  }
}
const DISPLAYED_BODY = { inertMarker: null, ariaHidden: null, contentVisibility: "visible", inert: false }
const RETAINED_INERT_BODY = { inertMarker: "true", ariaHidden: "true", contentVisibility: "hidden", inert: true }

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
  test("renders the panel shell, then mounts the selected workspace tool after the shell settles", async () => {
    renderPanel(openState)

    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toBeInTheDocument()
    expect(screen.getByTestId("workspace-panel-shell")).toHaveAttribute("data-open", "true")
    // Content construction is deferred behind the opening shell's paint.
    expect(screen.queryByText("workspace body")).not.toBeInTheDocument()
    expect(await screen.findByText("workspace body")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-panel-shell")).toHaveAttribute("data-shell-settled", "true")
  })

  test("renders navigator-backed shell with the selected workspace tool mounted", async () => {
    renderPanel({ ...openState, navigator: "files" })

    expect(screen.getByRole("complementary", { name: "Workspace panel" })).toBeInTheDocument()
    expect(await screen.findByText("workspace body")).toBeInTheDocument()
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

  test("does not construct the workspace tool while closed; mounts it on open after settle", async () => {
    const [state, setState] = createSignal<WorkspacePanelState>({ ...openState, open: false })
    render(() => (
      <WorkspacePanel
        state={state()}
        renderMode={() => <div>workspace body</div>}
      />
    ))

    expect(screen.queryByRole("complementary", { name: "Workspace panel" })).not.toBeInTheDocument()
    expect(screen.queryByRole("separator", { name: "Resize workspace panel" })).not.toBeInTheDocument()
    // A closed panel owns no content: nothing constructs until it opens.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve))))
    expect(screen.queryByText("workspace body")).not.toBeInTheDocument()
    setState(openState)
    expect(await screen.findByText("workspace body")).toBeInTheDocument()
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

  test("a content identity change hides the old body inert in the same flush and defers the new one", async () => {
    let mounts = 0
    let cleanups = 0
    const Body = (props: { dir: string }) => {
      onMount(() => {
        mounts++
      })
      onCleanup(() => {
        cleanups++
      })
      return <div>{`workspace body ${props.dir}`}</div>
    }
    const [state, setState] = createSignal(openState)

    render(() => (
      <WorkspacePanel
        state={state()}
        contentIdentity={(state) => ({ workspaceDir: state.workspaceDir })}
        renderMode={(_mode, state) => <Body dir={state.workspaceDir ?? ""} />}
      />
    ))

    await waitFor(() => expect(mounts).toBe(1))

    setState({ ...openState, workspaceDir: "/other" })

    // The outgoing body stops being the user's surface immediately — it is
    // retained, but proved inert — and the skeleton holds the box while the
    // destination's frames belong to whatever the click actually activated.
    expect(cleanups).toBe(0)
    expect(mounts).toBe(1)
    expect(panelBodyState("workspace body /workspace")).toEqual(RETAINED_INERT_BODY)
    expect(screen.queryByText("workspace body /other")).not.toBeInTheDocument()
    expect(screen.getByTestId("workspace-review-pending")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-panel-shell")).toHaveAttribute("data-shell-settled", "false")

    // ...and the destination is then constructed exactly once, behind the gate.
    expect(await screen.findByText("workspace body /other")).toBeInTheDocument()
    expect(mounts).toBe(2)
    expect(cleanups).toBe(0)
    expect(panelBodyState("workspace body /other")).toEqual(DISPLAYED_BODY)
    expect(panelBodyState("workspace body /workspace")).toEqual(RETAINED_INERT_BODY)
    expect(screen.getByTestId("workspace-panel-shell")).toHaveAttribute("data-shell-settled", "true")
  })

  test("returning to a retained identity flips the display locks instead of reconstructing", async () => {
    let mounts = 0
    let cleanups = 0
    const Body = (props: { dir: string }) => {
      onMount(() => {
        mounts++
      })
      onCleanup(() => {
        cleanups++
      })
      return <div>{`workspace body ${props.dir}`}</div>
    }
    const [state, setState] = createSignal(openState)

    render(() => (
      <WorkspacePanel
        state={state()}
        contentIdentity={(state) => ({ workspaceDir: state.workspaceDir })}
        renderMode={(_mode, state) => <Body dir={state.workspaceDir ?? ""} />}
      />
    ))

    await waitFor(() => expect(mounts).toBe(1))
    setState({ ...openState, workspaceDir: "/other" })
    expect(await screen.findByText("workspace body /other")).toBeInTheDocument()
    expect(mounts).toBe(2)

    // Back to the first workspace. The return is a flip, so it lands in the
    // same flush as the state change — no construction and no settle wait.
    setState(openState)

    expect(mounts).toBe(2)
    expect(cleanups).toBe(0)
    expect(panelBodyState("workspace body /workspace")).toEqual(DISPLAYED_BODY)
    expect(panelBodyState("workspace body /other")).toEqual(RETAINED_INERT_BODY)
    expect(screen.queryByTestId("workspace-review-pending")).not.toBeInTheDocument()
  })

  test("only the displayed body is told it is displayed", async () => {
    const displayedByDir = new Map<string, () => boolean>()
    const [state, setState] = createSignal(openState)

    render(() => (
      <WorkspacePanel
        state={state()}
        contentIdentity={(state) => ({ workspaceDir: state.workspaceDir })}
        renderMode={(_mode, state, displayed) => {
          displayedByDir.set(state.workspaceDir ?? "", displayed)
          return <div>{`workspace body ${state.workspaceDir ?? ""}`}</div>
        }}
      />
    ))

    await waitFor(() => expect(displayedByDir.get("/workspace")?.()).toBe(true))
    setState({ ...openState, workspaceDir: "/other" })
    expect(await screen.findByText("workspace body /other")).toBeInTheDocument()

    expect(displayedByDir.get("/workspace")?.()).toBe(false)
    expect(displayedByDir.get("/other")?.()).toBe(true)
  })

  test("retention is bounded: a third identity disposes the least recently displayed body", async () => {
    const cleanups: string[] = []
    const Body = (props: { dir: string }) => {
      onCleanup(() => cleanups.push(props.dir))
      return <div>{`workspace body ${props.dir}`}</div>
    }
    const [state, setState] = createSignal(openState)

    render(() => (
      <WorkspacePanel
        state={state()}
        contentIdentity={(state) => ({ workspaceDir: state.workspaceDir })}
        renderMode={(_mode, state) => <Body dir={state.workspaceDir ?? ""} />}
      />
    ))

    await waitFor(() => expect(screen.getByText("workspace body /workspace")).toBeInTheDocument())
    setState({ ...openState, workspaceDir: "/second" })
    expect(await screen.findByText("workspace body /second")).toBeInTheDocument()
    // Two bodies live, none disposed.
    expect(cleanups).toEqual([])
    expect(screen.getAllByTestId("workspace-panel-body")).toHaveLength(2)

    setState({ ...openState, workspaceDir: "/third" })
    expect(await screen.findByText("workspace body /third")).toBeInTheDocument()

    // /workspace was the stalest, so it is the one that goes; the panel never
    // holds more than the displayed body plus one neighbour.
    expect(cleanups).toEqual(["/workspace"])
    expect(screen.queryByText("workspace body /workspace")).not.toBeInTheDocument()
    expect(screen.getAllByTestId("workspace-panel-body")).toHaveLength(2)
    expect(panelBodyState("workspace body /third")).toEqual(DISPLAYED_BODY)
    expect(panelBodyState("workspace body /second")).toEqual(RETAINED_INERT_BODY)
  })

  test("closing the panel drops the retained neighbour and keeps the displayed body", async () => {
    vi.useFakeTimers()
    const cleanups: string[] = []
    const Body = (props: { dir: string }) => {
      onCleanup(() => cleanups.push(props.dir))
      return <div>{`workspace body ${props.dir}`}</div>
    }
    const [state, setState] = createSignal(openState)

    render(() => (
      <WorkspacePanel
        state={state()}
        contentIdentity={(state) => ({ workspaceDir: state.workspaceDir })}
        renderMode={(_mode, state) => <Body dir={state.workspaceDir ?? ""} />}
      />
    ))

    await vi.advanceTimersByTimeAsync(600)
    setState({ ...openState, workspaceDir: "/other" })
    await vi.advanceTimersByTimeAsync(600)
    expect(screen.getByText("workspace body /other")).toBeInTheDocument()
    expect(screen.getAllByTestId("workspace-panel-body")).toHaveLength(2)

    setState({ ...openState, workspaceDir: "/other", open: false })
    await vi.advanceTimersByTimeAsync(600)

    // The neighbour goes; the displayed body survives the close grace so a
    // reopen does not reconstruct it (the workbench drops the whole shell).
    expect(cleanups).toEqual(["/workspace"])
    expect(screen.getAllByTestId("workspace-panel-body")).toHaveLength(1)
    expect(screen.getByText("workspace body /other")).toBeInTheDocument()
  })

  test("unmounting the panel disposes every retained body", async () => {
    const cleanups: string[] = []
    const Body = (props: { dir: string }) => {
      onCleanup(() => cleanups.push(props.dir))
      return <div>{`workspace body ${props.dir}`}</div>
    }
    const [state, setState] = createSignal(openState)

    const view = render(() => (
      <WorkspacePanel
        state={state()}
        contentIdentity={(state) => ({ workspaceDir: state.workspaceDir })}
        renderMode={(_mode, state) => <Body dir={state.workspaceDir ?? ""} />}
      />
    ))

    await waitFor(() => expect(screen.getByText("workspace body /workspace")).toBeInTheDocument())
    setState({ ...openState, workspaceDir: "/other" })
    expect(await screen.findByText("workspace body /other")).toBeInTheDocument()

    view.unmount()

    // The closed panel's zero-DOM contract is the workbench unmounting this
    // shell, and that must take the whole store with it.
    expect(cleanups.sort()).toEqual(["/other", "/workspace"])
    expect(screen.queryAllByTestId("workspace-panel-body")).toHaveLength(0)
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
