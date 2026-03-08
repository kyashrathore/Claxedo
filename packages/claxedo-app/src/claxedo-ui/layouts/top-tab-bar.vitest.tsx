import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"

const tabs = {
  active: () => undefined as any,
  activeId: () => undefined as string | undefined,
  items: () => [] as any[],
  visualOrderedItems: () => [] as any[],
  orderedItems: () => [] as any[],
  order: () => [] as string[],
  setActive: vi.fn(),
  close: vi.fn(),
}

const claxedo = {
  groupTabs: () => tabs,
  groupWorktree: () => ({
    pinned: () => null as string | null,
    default: () => "/ws/main",
    setPinned: vi.fn(),
    setDefault: vi.fn(),
  }),
  topTabs: tabs,
  worktree: {
    pinned: () => null as string | null,
    default: () => "/ws/main",
  },
  getWorktreeColor: (dir: string) => (dir === "/ws/main" ? "#22c55e" : "#3b82f6"),
  getActiveWorktreeColor: () => "#22c55e",
  split: {
    active: () => false,
    groups: () => [{ id: "g-default" }],
    moveTab: vi.fn(),
  },
  select: {
    multiPaneLeafView: () => [] as any[],
  },
  dispatch: vi.fn(),
  processPane: {
    requestToggle: vi.fn(),
    requestOpen: vi.fn(),
    crashedWhileClosed: () => false,
    running: () => false,
  },
  terminal: {
    ids: () => [] as string[],
    agentStatus: () => "idle",
    isTracked: () => false,
    seen: () => false,
  },
}

vi.mock("../context/claxedo-layout", () => ({
  useClaxedoLayout: () => claxedo,
}))

vi.mock("@thisbeyond/solid-dnd", () => ({
  SortableProvider: (props: any) => <>{props.children}</>,
  createSortable: () =>
    Object.assign(() => {}, {
      isActiveDraggable: false,
    }),
  createDroppable: () => () => {},
}))

vi.mock("@opencode-ai/claxedo-app", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
  useServer: () => ({
    healthy: () => true,
  }),
}))

vi.mock("@opencode-ai/ui/theme", () => ({
  useTheme: () => ({
    mode: () => "light",
  }),
}))

vi.mock("@/context/terminal", () => ({
  useOptionalTerminal: () => undefined,
}))

vi.mock("@/context/global-sync", () => ({
  useGlobalSync: () => ({
    child: () => [{ session_status: {}, permission: {} }],
  }),
}))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({
    url: "http://localhost:4096",
    client: {
      session: {
        messages: async () => ({ data: [] }),
      },
    },
  }),
}))

vi.mock("@opencode-ai/ui/icon", () => ({
  Icon: () => <span />,
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: any) => <button onClick={props.onClick}>{props.children}</button>,
}))

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: any) => <>{props.children}</>,
}))

vi.mock("@opencode-ai/ui/dropdown-menu", () => {
  const DropdownMenu: any = (props: any) => <>{props.children}</>
  DropdownMenu.Trigger = (props: any) => <button>{props.children}</button>
  DropdownMenu.Portal = (props: any) => <>{props.children}</>
  DropdownMenu.Content = (props: any) => <div>{props.children}</div>
  DropdownMenu.Item = (props: any) => <button onClick={props.onSelect}>{props.children}</button>
  DropdownMenu.Separator = () => <hr />
  return { DropdownMenu }
})

vi.mock("@opencode-ai/ui/popover", () => ({
  Popover: (props: any) => (
    <>
      {props.trigger}
      {props.children}
    </>
  ),
}))

vi.mock("@opencode-ai/ui/list", () => ({
  List: (props: any) => (
    <div>
      {props.items.map((item: any) => (
        <button data-list-item={item.directory} onClick={() => props.onSelect?.(item)}>
          {props.children(item)}
        </button>
      ))}
    </div>
  ),
}))

vi.mock("../../components/settings-terminals", () => ({
  getTerminalCommands: () => ({
    claude: "claude",
    codex: "codex",
    custom: [],
  }),
}))

vi.mock("../../overrides/utils/debug", () => ({
  createDebugLogger: () => ({
    log: () => {},
    verbose: () => {},
    enabled: () => false,
  }),
}))

import { TopTabBar, WorkspaceBar } from "./top-tab-bar"

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  tabs.setActive.mockReset()
  tabs.close.mockReset()
  claxedo.processPane.requestToggle.mockReset()
  claxedo.processPane.requestOpen.mockReset()
})

describe("TopTabBar separators", () => {
  test("renders divider only when adjacent tabs cross worktree boundary", () => {
    const list = [
      {
        id: "t1",
        type: "session",
        title: "A",
        directory: "/ws/main",
        closable: true,
      },
      {
        id: "t2",
        type: "session",
        title: "B",
        directory: "/ws/main",
        closable: true,
      },
      {
        id: "t3",
        type: "session",
        title: "C",
        directory: "/ws/feature",
        closable: true,
      },
    ]
    tabs.active = () => list[0]
    tabs.activeId = () => list[0].id
    tabs.items = () => list as any[]
    tabs.visualOrderedItems = () => list as any[]
    tabs.orderedItems = () => list as any[]
    tabs.order = () => list.map((tab) => tab.id)

    const { container } = render(() => (
      <TopTabBar groupId="g-default" showSidebarToggle={false} />
    ))

    const dividers = container.querySelectorAll("div.w-px.h-10.bg-border-weak-base.flex-shrink-0")
    expect(dividers.length).toBe(1)
  })

  test("renders no divider when all tabs are in the same worktree", () => {
    const list = [
      {
        id: "s1",
        type: "session",
        title: "One",
        directory: "/ws/main",
        closable: true,
      },
      {
        id: "s2",
        type: "terminal",
        title: "Two",
        directory: "/ws/main",
        closable: true,
      },
      {
        id: "s3",
        type: "review",
        title: "Three",
        directory: "/ws/main",
        closable: true,
      },
    ]
    tabs.active = () => list[0]
    tabs.activeId = () => list[0].id
    tabs.items = () => list as any[]
    tabs.visualOrderedItems = () => list as any[]
    tabs.orderedItems = () => list as any[]
    tabs.order = () => list.map((tab) => tab.id)

    const { container } = render(() => (
      <TopTabBar groupId="g-default" showSidebarToggle={false} />
    ))

    const dividers = container.querySelectorAll("div.w-px.h-10.bg-border-weak-base.flex-shrink-0")
    expect(dividers.length).toBe(0)
  })

  test("groups tabs by worktree and inserts action buttons after selected group", () => {
    const list = [
      { id: "t1", type: "session", title: "One", directory: "/ws/main", closable: true },
      { id: "t2", type: "session", title: "Two", directory: "/ws/main", closable: true },
      { id: "t3", type: "session", title: "Three", directory: "/ws/feature", closable: true },
      { id: "t4", type: "session", title: "Four", directory: "/ws/main", closable: true },
    ]
    tabs.active = () => list[0]
    tabs.activeId = () => list[0].id
    tabs.items = () => list as any[]
    tabs.visualOrderedItems = () => list as any[]
    tabs.orderedItems = () => list as any[]
    tabs.order = () => list.map((tab) => tab.id)

    const { container } = render(() => (
      <TopTabBar groupId="g-default" showSidebarToggle={false} />
    ))
    const nodes = Array.from(container.querySelectorAll("[data-tab-id], [data-tab-actions='true']")).map((node) => {
      if (node instanceof HTMLElement && node.dataset.tabActions === "true") return "actions"
      if (node instanceof HTMLElement && node.dataset.tabId) return node.dataset.tabId
      return null
    })

    expect(nodes).toEqual(["t1", "t2", "t4", "t3", "actions"])
  })
})

describe("Workspace button click behavior", () => {
  test("workspace bar shows only the current workspace with the Current label", () => {
    const projects = [
      {
        id: "p1",
        name: "Project",
        worktree: "/ws/main",
        workspaces: [
          { id: "w1", directory: "/ws/main", name: "main" },
          { id: "w2", directory: "/ws/feature", name: "feature" },
        ],
      },
    ]

    const { container, getByText, queryByText } = render(() => (
      <WorkspaceBar
        projects={projects as any}
        defaultDirectory="/ws/main"
        pinnedDirectory={null}
      />
    ))

    expect(getByText("Current:")).toBeTruthy()
    expect(container.querySelector('[data-workspace-button="/ws/main"]')).toBeTruthy()
    expect(container.querySelector('[data-workspace-button="/ws/feature"]')).toBeFalsy()
    expect(queryByText("feature")).toBeNull()
  })

  test("clicking workspace name selects workspace and does not toggle process pane", () => {
    const onWorktreeClick = vi.fn()
    const projects = [
      {
        id: "p1",
        name: "Project",
        worktree: "/ws/main",
        workspaces: [{ id: "w1", directory: "/ws/main", name: "main" }],
      },
    ]

    const { container } = render(() => (
      <WorkspaceBar
        projects={projects as any}
        defaultDirectory="/ws/main"
        pinnedDirectory={null}
        onWorktreeClick={onWorktreeClick}
      />
    ))

    const workspace = container.querySelector('[data-workspace-button="/ws/main"]') as HTMLElement | null
    expect(workspace).toBeTruthy()
    fireEvent.click(workspace!, { detail: 1 })

    expect(onWorktreeClick).toHaveBeenCalledTimes(1)
    expect(onWorktreeClick).toHaveBeenCalledWith("p1", "/ws/main")
    expect(claxedo.processPane.requestToggle).not.toHaveBeenCalled()
    expect(claxedo.processPane.requestOpen).not.toHaveBeenCalled()
  })

  test("selecting a workspace from overflow switches to that workspace", () => {
    const onWorktreeClick = vi.fn()

    const { container } = render(() => (
      <WorkspaceBar
        projects={[
          {
            id: "p1",
            name: "Project",
            worktree: "/ws/main",
            workspaces: [{ id: "w1", directory: "/ws/main", name: "main" }],
          },
        ] as any}
        allProjects={[
          {
            id: "p1",
            name: "Project",
            worktree: "/ws/main",
            sandboxes: ["/ws/feature"],
          },
        ] as any}
        defaultDirectory="/ws/main"
        pinnedDirectory={null}
        onWorktreeClick={onWorktreeClick}
      />
    ))

    const item = container.querySelector('[data-list-item="/ws/feature"]') as HTMLElement | null
    expect(item).toBeTruthy()
    fireEvent.click(item!)

    expect(onWorktreeClick).toHaveBeenCalledTimes(1)
    expect(onWorktreeClick).toHaveBeenCalledWith("p1", "/ws/feature")
  })
})
