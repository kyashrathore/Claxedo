import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import { ClaxedoStateProvider, useClaxedoState, type ClaxedoStateApi } from "../state/index"
import { emptyClaxedoState } from "../state/persistence"
import type { ClaxedoState, ContentMeta } from "../state/types"
import type { WorkspacePanelPaneTarget } from "../../../features/workspaces/ui/panel/workspace-panel-state"
import { NavigatorSidebar, paneSessionScope } from "./navigator-sidebar"
import { panePresentationUnderWorkspacePanel } from "../../app-shell-layout"

const navigators = vi.hoisted(() => ({
  processProviders: [] as Array<{ directory?: string; isOpen?: () => boolean }>,
}))

vi.mock("@/platform/i18n/provider", async () => {
  const en = await vi.importActual<typeof import("@/platform/i18n/en")>("@/platform/i18n/en")
  const dict = new Map(Object.entries(en.dict))
  return { useLanguage: () => ({ t: (key: string) => dict.get(key) ?? key }) }
})

vi.mock("@/ui/semantic-icon", () => ({
  SemanticIcon: (props: { concept: string }) => <span data-testid="semantic-icon" data-concept={props.concept} />,
}))

vi.mock("@/features/session/ui/components/session-pane-scope", () => ({
  SessionPaneScope: (props: { children: JSX.Element; directory: string }) => (
    <div data-testid="session-pane-scope" data-directory={props.directory}>{props.children}</div>
  ),
}))

vi.mock("@/app/workbench/context/process-pane", () => ({
  ProcessPaneProvider: (props: { children: JSX.Element; directory?: string; isOpen?: () => boolean }) => {
    navigators.processProviders.push({ directory: props.directory, isOpen: props.isOpen })
    return <>{props.children}</>
  },
  useWorkspaceProcessPane: () => ({}),
}))

vi.mock("@/app/workbench/workspace-panel/files-navigator", () => ({
  WorkspaceFilesNavigator: (props: {
    mode: "files" | "changes"
    active: boolean
    activePath?: string
    onFileClick: (path: string, intent: "tab" | "review") => void
  }) => {
    return (
      <div data-testid="workspace-files-navigator" data-mode={props.mode} data-active={String(props.active)} data-path={props.activePath ?? ""}>
        <button type="button" onClick={() => props.onFileClick("src/app.ts", "review")}>src/app.ts</button>
      </div>
    )
  },
}))

vi.mock("@/features/processes/ui", () => ({
  WorkspaceProcessesNavigator: (props: {
    directory: string
    activeProcessId?: string
    onProcessSelect: (processId: string) => void
  }) => {
    return (
      <div data-testid="workspace-processes-navigator" data-directory={props.directory} data-process={props.activeProcessId ?? ""}>
        <button type="button" onClick={() => props.onProcessSelect("proc-dev")}>dev</button>
      </div>
    )
  },
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ fetch }),
}))

beforeEach(() => {
  navigators.processProviders = []
})

afterEach(() => {
  cleanup()
})

const sessionSurface: ContentMeta = {
  id: "surface-1",
  type: "session",
  scope: "directory",
  directory: "/repo/main",
  sessionId: "ses_1",
  content: {
    type: "session",
    directory: "/repo/main",
    sessionId: "ses_1",
    sessionRef: { sessionId: "ses_1", host: "workspace", cwd: "/repo/main", toolSandbox: { kind: "local", cwd: "/repo/main" } },
  },
}

function stateWith(input: { tab?: "files" | "changes" | "processes"; surface?: ContentMeta }): ClaxedoState {
  const base = emptyClaxedoState()
  const surface = input.surface
  return {
    ...base,
    navigator: { width: 320, tab: input.tab ?? "changes" },
    ...(surface
      ? {
        workbench: {
          panes: [{ id: "pane-1", contentId: surface.id }],
          split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane-1" } },
          contentIds: [surface.id],
          contentRecency: [surface.id],
          focusedPaneId: "pane-1",
          layoutSnapshots: {},
        },
        meta: { [surface.id]: surface },
      }
      : {}),
  }
}

const target: WorkspacePanelPaneTarget = { workspaceDir: "/repo/main", targetPaneId: "pane-1" }

function renderSidebar(input: {
  state: ClaxedoState
  target?: WorkspacePanelPaneTarget
  width?: number
  onResize?: (width: number) => void
  onResizeEnd?: () => void
}) {
  let api: ClaxedoStateApi | undefined
  const Probe = () => {
    api = useClaxedoState()
    return null
  }
  render(() => (
    <ClaxedoStateProvider initialState={input.state}>
      <Probe />
      <NavigatorSidebar
        width={() => input.width ?? 320}
        onResize={input.onResize ?? (() => undefined)}
        onResizeEnd={input.onResizeEnd ?? (() => undefined)}
        target={() => input.target}
      />
    </ClaxedoStateProvider>
  ))
  return { state: () => api! }
}

describe("NavigatorSidebar", () => {
  test("renders the three tabs with their semantic icons and selects the persisted tab", () => {
    renderSidebar({ state: stateWith({ tab: "changes", surface: sessionSurface }), target })

    const aside = screen.getByTestId("navigator-sidebar")
    expect(aside.getAttribute("data-tab")).toBe("changes")
    const tabs = screen.getAllByRole("tab")
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Files", "Changes", "Processes"])
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false"])
    const icons = screen.getAllByTestId("semantic-icon").map((icon) => icon.getAttribute("data-concept"))
    expect(icons).toEqual(["files", "changes", "processes"])
  })

  test("Files and Changes mount the files navigator in the matching mode; Processes mounts the processes navigator", () => {
    const { state } = renderSidebar({ state: stateWith({ tab: "changes", surface: sessionSurface }), target })

    expect(screen.getByTestId("workspace-files-navigator").getAttribute("data-mode")).toBe("changes")
    expect(screen.getByTestId("workspace-files-navigator").getAttribute("data-active")).toBe("true")
    expect(screen.queryByTestId("workspace-processes-navigator")).toBeNull()

    fireEvent.click(screen.getByTestId("navigator-sidebar-tab-files"))
    expect(state().navigator.tab()).toBe("files")
    expect(screen.getByTestId("workspace-files-navigator").getAttribute("data-mode")).toBe("files")

    fireEvent.click(screen.getByTestId("navigator-sidebar-tab-processes"))
    expect(screen.getByTestId("navigator-sidebar").getAttribute("data-tab")).toBe("processes")
    expect(screen.getByTestId("workspace-processes-navigator").getAttribute("data-directory")).toBe("/repo/main")
    expect(screen.getByTestId("workspace-files-navigator").getAttribute("data-active")).toBe("false")
    expect(navigators.processProviders).toHaveLength(1)
    expect(navigators.processProviders[0]?.directory).toBe("/repo/main")
    expect(navigators.processProviders[0]?.isOpen?.()).toBe(true)

    fireEvent.click(screen.getByTestId("navigator-sidebar-tab-changes"))
    expect(navigators.processProviders[0]?.isOpen?.()).toBe(false)
    expect(screen.getByTestId("workspace-files-navigator").getAttribute("data-mode")).toBe("changes")
  })

  test("a file click opens the panel in review mode with a file focus for the target", () => {
    const { state } = renderSidebar({ state: stateWith({ tab: "changes", surface: sessionSurface }), target })

    fireEvent.click(screen.getByRole("button", { name: "src/app.ts" }))

    const panel = state().workspacePanel.state()
    expect(panel).toMatchObject({
      open: true,
      mode: "review",
      workspaceDir: "/repo/main",
      targetPaneId: "pane-1",
      navigator: "changes",
      focus: { kind: "file", path: "src/app.ts", intent: "review", version: 1 },
    })
    expect(screen.getByTestId("workspace-files-navigator").getAttribute("data-path")).toBe("src/app.ts")
  })

  test("a process click opens the panel with a process focus", () => {
    const { state } = renderSidebar({ state: stateWith({ tab: "processes", surface: sessionSurface }), target })

    fireEvent.click(screen.getByRole("button", { name: "dev" }))

    expect(state().workspacePanel.state()).toMatchObject({
      open: true,
      mode: "review",
      workspaceDir: "/repo/main",
      targetPaneId: "pane-1",
      navigator: "processes",
      focus: { kind: "process", processId: "proc-dev", version: 1 },
    })
    expect(screen.getByTestId("workspace-processes-navigator").getAttribute("data-process")).toBe("proc-dev")
  })

  test("without a target it shows the empty state and mounts no navigator", () => {
    renderSidebar({ state: stateWith({ tab: "files" }) })

    expect(screen.getByTestId("navigator-sidebar-empty").textContent).toBe("Select a workspace to use the navigator.")
    expect(screen.queryByTestId("workspace-files-navigator")).toBeNull()
    expect(screen.queryByTestId("session-pane-scope")).toBeNull()
    expect(screen.getAllByRole("tab")).toHaveLength(3)
  })

  test("the resize handle is a vertical separator over the navigator range and steps 24px on arrow keys", () => {
    const onResize = vi.fn()
    const onResizeEnd = vi.fn()
    renderSidebar({ state: stateWith({ tab: "files", surface: sessionSurface }), target, width: 320, onResize, onResizeEnd })

    const handle = screen.getByRole("separator")
    expect(handle.getAttribute("aria-orientation")).toBe("vertical")
    expect(handle.getAttribute("aria-valuemin")).toBe("260")
    expect(handle.getAttribute("aria-valuemax")).toBe("520")
    expect(handle.getAttribute("aria-valuenow")).toBe("320")
    expect(screen.getByTestId("navigator-sidebar").style.width).toBe("320px")

    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(onResize).toHaveBeenLastCalledWith(344)
    expect(onResizeEnd).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(onResize).toHaveBeenLastCalledWith(296)
    expect(onResizeEnd).toHaveBeenCalledTimes(2)
  })

  test("the resize handle follows pointer drags and commits on release", () => {
    const onResize = vi.fn()
    const onResizeEnd = vi.fn()
    renderSidebar({ state: stateWith({ tab: "files", surface: sessionSurface }), target, width: 320, onResize, onResizeEnd })
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0)
      return 1
    })

    // jsdom has no PointerEvent; a MouseEvent carries the same clientX.
    const handle = screen.getByRole("separator")
    handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 320, bubbles: true }))
    expect(document.body.style.cursor).toBe("col-resize")
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 360 }))
    expect(onResize).toHaveBeenLastCalledWith(360)
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 360 }))
    expect(onResizeEnd).toHaveBeenCalledTimes(1)
    expect(document.body.style.cursor).toBe("")
    frame.mockRestore()
  })
})

describe("paneSessionScope", () => {
  test("reads the target pane's session identity", () => {
    const { state } = renderSidebar({ state: stateWith({ tab: "files", surface: sessionSurface }), target })
    expect(paneSessionScope(state(), "pane-1")).toEqual({
      surfaceId: "surface-1",
      sessionId: "ses_1",
      sessionRef: sessionSurface.content?.sessionRef,
    })
  })
})

describe("panePresentationUnderWorkspacePanel", () => {
  const base = { panelOpen: true, panelFullWidth: true, targetPaneId: "pane-1", focusedPaneId: "pane-2" }

  test("the targeted pane floats while the panel is open at full view", () => {
    expect(panePresentationUnderWorkspacePanel({ ...base, paneId: "pane-1" })).toBe("floating")
  })

  test("a px-width panel docks every pane", () => {
    expect(panePresentationUnderWorkspacePanel({ ...base, paneId: "pane-1", panelFullWidth: false })).toBe("docked")
  })

  test("a closed panel docks every pane", () => {
    expect(panePresentationUnderWorkspacePanel({ ...base, paneId: "pane-1", panelOpen: false })).toBe("docked")
  })

  test("a pane the panel does not target stays docked", () => {
    expect(panePresentationUnderWorkspacePanel({ ...base, paneId: "pane-2" })).toBe("docked")
  })

  test("a targetless panel floats the focused pane only", () => {
    expect(panePresentationUnderWorkspacePanel({ ...base, targetPaneId: undefined, paneId: "pane-2" })).toBe("floating")
    expect(panePresentationUnderWorkspacePanel({ ...base, targetPaneId: undefined, paneId: "pane-1" })).toBe("docked")
  })
})
