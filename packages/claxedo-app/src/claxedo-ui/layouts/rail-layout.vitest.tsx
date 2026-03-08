import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen } from "@solidjs/testing-library"

const register = vi.fn()

const tabsByGroup: Record<string, any> = {}

const makeTabs = (groupId: string) => {
  if (tabsByGroup[groupId]) return tabsByGroup[groupId]
  const tabs = {
    items: () => [
      {
        id: `session-${groupId}`,
        type: "session",
        directory: "/ws/main",
        title: "Session",
        sessionId: `ses-${groupId}`,
      },
    ],
    active: () => ({
      id: `session-${groupId}`,
      type: "session",
      directory: "/ws/main",
      title: "Session",
      sessionId: `ses-${groupId}`,
    }),
    activeId: () => `session-${groupId}`,
    setActive: vi.fn(),
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
    pinned: () => true,
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
  useServer: () => ({
    isLocal: () => true,
  }),
}))

vi.mock("./rail-sidebar", () => ({
  RailSidebar: () => <div data-testid="rail-sidebar" />,
}))

vi.mock("./top-tab-bar", () => ({
  TopTabBar: (props: any) => <div data-testid={`top-tab-bar-${props.groupId}`} />,
  TabDragOverlay: () => null,
  WorkspaceBar: () => <div data-testid="workspace-bar" />,
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

vi.mock("../../overrides/utils/debug", () => ({
  createDebugLogger: () => ({
    log: () => {},
  }),
}))

import { RailLayoutInner } from "./rail-layout"

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  register.mockReset()
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
})
