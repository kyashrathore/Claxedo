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
  processPane: {
    requestToggle: vi.fn(),
    requestOpen: vi.fn(),
    crashedWhileClosed: () => false,
  },
  terminal: {
    ids: () => [] as string[],
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
}))

vi.mock("@opencode-ai/ui/theme", () => ({
  useTheme: () => ({
    mode: () => "light",
  }),
}))

vi.mock("@/context/terminal", () => ({
  useOptionalTerminal: () => undefined,
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
  Popover: (props: any) => <>{props.children}</>,
}))

vi.mock("@opencode-ai/ui/list", () => ({
  List: () => <div />,
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

    expect(nodes).toEqual(["t1", "t2", "t4", "actions", "t3"])
  })
})

describe("Workspace indicator click behavior", () => {
  test("clicking current workspace indicator toggles process pane without selecting workspace", () => {
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

    const dot = container.querySelector('[data-workspace-indicator="true"]') as HTMLElement
    expect(dot).toBeTruthy()
    fireEvent.pointerDown(dot)
    fireEvent.click(dot)

    expect(claxedo.processPane.requestToggle).toHaveBeenCalledTimes(1)
    expect(claxedo.processPane.requestToggle).toHaveBeenCalledWith("/ws/main")
    expect(claxedo.processPane.requestOpen).not.toHaveBeenCalled()
    expect(onWorktreeClick).not.toHaveBeenCalled()
  })

  test("clicking non-current workspace indicator toggles pane and does not select workspace", () => {
    const onWorktreeClick = vi.fn()
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

    const { container } = render(() => (
      <WorkspaceBar
        projects={projects as any}
        defaultDirectory="/ws/main"
        pinnedDirectory={null}
        onWorktreeClick={onWorktreeClick}
      />
    ))

    const dots = Array.from(container.querySelectorAll('[data-workspace-indicator="true"]'))
    expect(dots.length).toBe(2)
    fireEvent.pointerDown(dots[1] as HTMLElement)
    fireEvent.click(dots[1] as HTMLElement)

    expect(claxedo.processPane.requestToggle).toHaveBeenCalledTimes(1)
    expect(claxedo.processPane.requestToggle).toHaveBeenCalledWith("/ws/feature")
    expect(claxedo.processPane.requestOpen).not.toHaveBeenCalled()
    expect(onWorktreeClick).not.toHaveBeenCalled()
  })
})
