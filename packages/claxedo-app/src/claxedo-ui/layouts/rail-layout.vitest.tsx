import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen } from "@solidjs/testing-library"

const register = vi.fn()
const platform = {
  platform: "desktop",
  os: "linux",
}

const tabsByGroup: Record<string, any> = {}

const makeTabs = (groupId: string) => {
  if (tabsByGroup[groupId]) return tabsByGroup[groupId]
  const tabs = {
    items: () => [],
    active: () => undefined,
    activeId: () => null,
    setActive: vi.fn(),
    addSession: vi.fn(),
    closeActive: vi.fn(),
    activateNext: vi.fn(),
    activatePrevious: vi.fn(),
    reopenLast: vi.fn(),
    visualOrderedItems: () => [],
    order: () => [],
    orderedItems: () => [],
    close: vi.fn(),
  }
  tabsByGroup[groupId] = tabs
  return tabs
}

const claxedo = {
  rail: {
    pinned: vi.fn(() => true),
    toggle: vi.fn(),
  },
  split: {
    active: () => false,
    hidden: () => false,
    direction: () => "h" as const,
    sizes: () => [0.5, 0.5],
    focusedId: () => "g1",
    setFocus: vi.fn(),
    toggle: vi.fn(),
    orderedGroups: () => [{ id: "g1" }, { id: "g2" }],
  },
  groupTabs: (groupId: string) => makeTabs(groupId),
  groupWorktree: () => ({
    default: () => "/ws/main",
    pinned: () => null,
    setPinned: vi.fn(),
    setDefault: vi.fn(),
  }),
  groupLayout: () => ({
    session: {
      width: () => 600,
      collapsed: () => false,
      panelMode: () => 0,
      setWidth: vi.fn(),
      setCollapsed: vi.fn(),
      setPanelMode: vi.fn(),
    },
    reviewPanel: {
      opened: () => false,
      setOpened: vi.fn(),
    },
  }),
  workspaceRecency: {
    recordAccess: vi.fn(),
  },
  cleanupDeletedWorktree: vi.fn(),
  select: {
    visibleGroups: () => [{ id: "g1" }, { id: "g2" }],
    groupActiveTab: (groupId: string) => makeTabs(groupId).active(),
  },
  dispatch: vi.fn(),
  findTabGroup: vi.fn(),
  canDragTabBetweenWorktrees: () => true,
  enabled: () => true,
  processPane: { setTargetDirectory: vi.fn(), running: vi.fn(() => false) },
}

vi.mock("../context/claxedo-layout", () => ({
  useClaxedoLayout: () => claxedo,
  ClaxedoLayoutProvider: (props: any) => <>{props.children}</>,
}))

vi.mock("@opencode-ai/claxedo-app", () => ({
  useCommand: () => ({
    register,
  }),
  usePlatform: () => platform,
  useServer: () => ({
    isLocal: () => true,
  }),
  useGlobalSync: () => ({
    refreshDirectory: vi.fn(),
    status: () => "ready",
    globalSessions: { store: { byProject: {} } },
  }),
  getAvatarColors: () => ({ bg: "#000", fg: "#fff" }),
}))

vi.mock("./rail-sidebar", () => ({
  RailSidebar: (props: any) => <div data-testid="rail-sidebar" data-traffic-light-pad={String(props.trafficLightPad)} />,
  parseOwnerRepo: (remote?: string) => remote ?? undefined,
}))

vi.mock("./top-tab-bar", () => ({
  TopTabBar: (props: any) => <div data-testid={`top-tab-bar-${props.groupId}`} />,
  TabDragOverlay: () => null,
  WorkspaceBar: () => <div data-testid="workspace-bar" />,
  WorkspaceScopeButtons: () => <div data-testid="workspace-scope-buttons" />,
}))

vi.mock("../components/group-content-renderer", () => ({
  GroupContentRenderer: () => <div data-testid="group-content" />,
}))

vi.mock("../components/process-pane", () => ({
  ProcessPane: () => <div data-testid="process-pane" />,
}))

vi.mock("../context/process-pane", () => ({
  ProcessPaneProvider: (props: any) => <>{props.children}</>,
}))

vi.mock("@/context/sdk", () => ({
  SDKProvider: (props: any) => <>{props.children}</>,
}))

vi.mock("@thisbeyond/solid-dnd", () => ({
  DragDropProvider: (props: any) => <>{props.children}</>,
  DragDropSensors: () => null,
  DragOverlay: (props: any) => <>{props.children}</>,
  closestCenter: () => null,
}))

vi.mock("@solid-primitives/media", () => ({
  createMediaQuery: () => false,
}))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: any) => <button>{props.children}</button>,
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: () => <button />,
}))

vi.mock("@opencode-ai/ui/popover", () => ({
  Popover: (props: any) => (
    <div>
      <button aria-label={props.triggerProps?.["aria-label"]}>{props.trigger}</button>
      <div>{props.children}</div>
    </div>
  ),
}))

vi.mock("../../overrides/utils/debug", () => ({
  createDebugLogger: () => ({
    log: () => {},
    verbose: () => {},
    enabled: () => false,
  }),
  setDebugTrace: () => {},
  patchDebugTrace: () => {},
  clearDebugTrace: () => {},
  readDebugTraceHistory: () => [],
  clearDebugTraceHistory: () => {},
}))

import { RailLayoutInner } from "./rail-layout"

const originalApi = (window as any).api

afterEach(() => {
  cleanup()
  ;(window as any).api = originalApi
})

beforeEach(() => {
  register.mockReset()
  platform.platform = "desktop"
  platform.os = "linux"
  claxedo.rail.pinned.mockReset()
  claxedo.rail.pinned.mockReturnValue(true)
  for (const key of Object.keys(tabsByGroup)) delete tabsByGroup[key]
  ;(window as any).api = undefined
})

describe("RailLayoutInner", () => {
  test("renders topBarRight content once even with split panels", () => {
    let calls = 0

    render(() => (
      <RailLayoutInner
        projects={[{ id: "p1", worktree: "/ws/main", name: "Project 1", sandboxes: [] }]}
        activeProjectId="p1"
        activeWorkspaceId="/ws/main"
        activeSessionId="ses-g1"
        homedir="/Users/test"
        onProjectSelect={() => {}}
        onWorkspaceSelect={() => {}}
        onSessionSelect={() => {}}
        onNewProject={() => {}}
        onNewWorkspace={async () => undefined}
        onSettings={() => {}}
        onHelp={() => {}}
        onNewSession={() => {}}
        onNewTerminal={() => {}}
        onTabSelect={() => {}}
        onDeleteSession={() => {}}
        onArchiveSession={() => {}}
        onDeleteWorkspace={() => {}}
        onRemoveProject={() => {}}
        topBarRight={() => {
          calls += 1
          return <div data-testid="top-right">right</div>
        }}
      />
    ))

    expect(screen.getAllByTestId("top-right")).toHaveLength(1)
    expect(calls).toBe(1)
  })

  test("registers Cmd+Backslash as split toggle keybind", () => {
    render(() => (
      <RailLayoutInner
        projects={[{ id: "p1", worktree: "/ws/main", name: "Project 1", sandboxes: [] }]}
        activeProjectId="p1"
        activeWorkspaceId="/ws/main"
        homedir="/Users/test"
        onProjectSelect={() => {}}
        onWorkspaceSelect={() => {}}
        onSessionSelect={() => {}}
        onNewProject={() => {}}
        onNewWorkspace={async () => undefined}
        onSettings={() => {}}
        onHelp={() => {}}
        onNewSession={() => {}}
        onNewTerminal={() => {}}
        onTabSelect={() => {}}
        onDeleteSession={() => {}}
        onArchiveSession={() => {}}
        onDeleteWorkspace={() => {}}
        onRemoveProject={() => {}}
      />
    ))

    const fn = register.mock.calls.find((call) => typeof call[0] === "function")?.[0]
    expect(fn).toBeTypeOf("function")
    const options = fn()
    const split = options.find((item: any) => item.id === "claxedo.split.toggle")
    const close = options.find((item: any) => item.id === "claxedo.tab.close")

    expect(split?.keybind).toBe("mod+\\")
    expect(close?.keybind).toBe("mod+w")
  })

  test("does NOT auto-create a tab when workspace is selected with no active tab (shows empty state instead)", () => {
    render(() => (
      <RailLayoutInner
        projects={[{ id: "p1", worktree: "/ws/main", name: "Project 1", sandboxes: [] }]}
        activeProjectId="p1"
        activeWorkspaceId="/ws/main"
        homedir="/Users/test"
        onProjectSelect={() => {}}
        onWorkspaceSelect={() => {}}
        onSessionSelect={() => {}}
        onNewProject={() => {}}
        onNewWorkspace={async () => undefined}
        onSettings={() => {}}
        onHelp={() => {}}
        onNewSession={() => {}}
        onNewTerminal={() => {}}
        onTabSelect={() => {}}
        onDeleteSession={() => {}}
        onArchiveSession={() => {}}
        onDeleteWorkspace={() => {}}
        onRemoveProject={() => {}}
      />
    ))

    // No auto-creation — tabs are only created by explicit user action
    expect(makeTabs("g1").addSession).not.toHaveBeenCalled()
    expect(makeTabs("g1").setActive).not.toHaveBeenCalled()
  })

  test("shows tab bar workspace label and separate selector trigger from the selected workspace even without tabs", () => {
    claxedo.rail.pinned.mockReturnValue(false)

    render(() => (
      <RailLayoutInner
        projects={[{ id: "p1", worktree: "/ws/main", name: "Project 1", sandboxes: [], workspaces: { "/ws/main": { id: "ws-main", directory: "/ws/main", kind: "local" } } }]}
        activeProjectId="p1"
        activeWorkspaceId="/ws/main"
        homedir="/Users/test"
        onProjectSelect={() => {}}
        onWorkspaceSelect={() => {}}
        onSessionSelect={() => {}}
        onNewProject={() => {}}
        onNewWorkspace={async () => undefined}
        onSettings={() => {}}
        onHelp={() => {}}
        onNewSession={() => {}}
        onNewTerminal={() => {}}
        onTabSelect={() => {}}
        onDeleteSession={() => {}}
        onArchiveSession={() => {}}
        onDeleteWorkspace={() => {}}
        onRemoveProject={() => {}}
      />
    ))

    expect(screen.getByText("main")).toBeInTheDocument()
    expect(screen.getByText("Project 1")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Select or create workspace" })).toBeInTheDocument()
  })

  test("drops mac traffic light padding when the desktop shell reports fullscreen on mount", async () => {
    platform.os = "macos"
    ;(window as any).api = {
      getWindowFullscreen: vi.fn().mockResolvedValue(true),
      onFullscreenChange: vi.fn(() => () => {}),
    }

    render(() => (
      <RailLayoutInner
        projects={[{ id: "p1", worktree: "/ws/main", name: "Project 1", sandboxes: [] }]}
        activeProjectId="p1"
        activeWorkspaceId="/ws/main"
        homedir="/Users/test"
        onProjectSelect={() => {}}
        onWorkspaceSelect={() => {}}
        onSessionSelect={() => {}}
        onNewProject={() => {}}
        onNewWorkspace={async () => undefined}
        onSettings={() => {}}
        onHelp={() => {}}
        onNewSession={() => {}}
        onNewTerminal={() => {}}
        onTabSelect={() => {}}
        onDeleteSession={() => {}}
        onArchiveSession={() => {}}
        onDeleteWorkspace={() => {}}
        onRemoveProject={() => {}}
      />
    ))

    const elt = await screen.findByTestId("rail-sidebar")
    await vi.waitFor(() => expect(elt).toHaveAttribute("data-traffic-light-pad", "false"))
  })
})
