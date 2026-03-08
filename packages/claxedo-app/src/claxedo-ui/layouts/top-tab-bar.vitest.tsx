import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"

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
    focusedId: () => "g-default",
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
  setDebugTrace: () => {},
  patchDebugTrace: () => {},
  clearDebugTrace: () => {},
  readDebugTraceHistory: () => [],
  clearDebugTraceHistory: () => {},
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

function useReactiveTabs(list: any[], active = list.at(-1)?.id) {
  const [items, setItems] = createSignal(list)
  const [activeId, setActiveId] = createSignal<string | undefined>(active)
  const [tabOrder, setTabOrder] = createSignal<string[]>(list.map((tab) => tab.id))
  const ordered = () => {
    const id = new Set(items().map((tab) => tab.id))
    const base = tabOrder().filter((tabId) => id.has(tabId))
    const extra = items().filter((tab) => !base.includes(tab.id)).map((tab) => tab.id)
    const next = [...base, ...extra]
    return next.map((tabId) => items().find((tab) => tab.id === tabId)).filter(Boolean) as any[]
  }

  tabs.items = items as any
  tabs.visualOrderedItems = ordered as any
  tabs.orderedItems = ordered as any
  tabs.order = tabOrder as any
  tabs.activeId = activeId as any
  tabs.active = () => items().find((tab) => tab.id === activeId())
  tabs.setActive = vi.fn((tabId: string) => setActiveId(tabId))
  tabs.close = vi.fn((tabId: string) => {
    const current = items()
    const next = current.filter((tab) => tab.id !== tabId)
    setItems(next)
    setTabOrder((all) => all.filter((id) => id !== tabId))
    if (activeId() !== tabId) return
    const idx = current.findIndex((tab) => tab.id === tabId)
    const fallback = next[idx] ?? next[idx - 1] ?? next[0]
    setActiveId(fallback?.id)
  })
}

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

describe("tab closing", () => {
  test("a failing onTabClose callback does not wedge future closes", async () => {
    useReactiveTabs([
      { id: "tab-session", type: "session", title: "Session", directory: "/ws/main", closable: true },
      { id: "tab-process", type: "process", title: "Processes", directory: "/ws/main", closable: true },
      { id: "tab-review", type: "review", title: "Review", directory: "/ws/main", closable: true },
    ], "tab-process")

    const close = vi.fn(() => {
      throw new Error("close callback boom")
    })

    const { container } = render(() => (
      <TopTabBar groupId="g-default" showSidebarToggle={false} onTabClose={close} />
    ))

    const buttons = () => Array.from(container.querySelectorAll('button[aria-label="Close tab"]')) as HTMLButtonElement[]

    expect(container.querySelector('[data-tab-id="tab-process"]')).toBeTruthy()
    fireEvent.click(buttons()[1]!)

    await waitFor(() => {
      expect(container.querySelector('[data-tab-id="tab-process"]')).toBeFalsy()
    })

    fireEvent.click(buttons()[0]!)

    await waitFor(() => {
      expect(container.querySelector('[data-tab-id="tab-session"]')).toBeFalsy()
    })

    expect(tabs.close).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
  })

  test("closing a process tab keeps surviving tab nodes mounted", async () => {
    useReactiveTabs([
      { id: "tab-session", type: "session", title: "Session", directory: "/ws/main", closable: true },
      { id: "tab-process", type: "process", title: "Processes", directory: "/ws/main", closable: true },
      { id: "tab-terminal", type: "terminal", title: "Terminal", directory: "/ws/main", closable: true },
    ], "tab-process")

    const { container } = render(() => (
      <TopTabBar groupId="g-default" showSidebarToggle={false} />
    ))

    const before = container.querySelector('[data-tab-id="tab-terminal"]')
    expect(before).toBeTruthy()

    const buttons = Array.from(container.querySelectorAll('button[aria-label="Close tab"]')) as HTMLButtonElement[]
    fireEvent.click(buttons[1]!)

    await waitFor(() => {
      expect(container.querySelector('[data-tab-id="tab-process"]')).toBeFalsy()
    })

    const after = container.querySelector('[data-tab-id="tab-terminal"]')
    expect(after).toBe(before)
  })
})

describe("process tab close lifecycle", () => {
  test("closing process tab allows switching to another tab via click", async () => {
    useReactiveTabs([
      { id: "tab-session", type: "session", title: "Session", directory: "/ws/main", closable: true },
      { id: "tab-process", type: "process", title: "Processes", directory: "/ws/main", closable: true },
      { id: "tab-terminal", type: "terminal", title: "Terminal", directory: "/ws/main", closable: true },
    ], "tab-process")

    const { container } = render(() => (
      <TopTabBar groupId="g-default" showSidebarToggle={false} />
    ))

    // Close the process tab
    const closeButtons = () =>
      Array.from(container.querySelectorAll('button[aria-label="Close tab"]')) as HTMLButtonElement[]
    fireEvent.click(closeButtons()[1]!)

    // Wait for process tab to disappear
    await waitFor(() => {
      expect(container.querySelector('[data-tab-id="tab-process"]')).toBeFalsy()
    })

    // Click on the session tab
    const sessionTab = container.querySelector('[data-tab-id="tab-session"]') as HTMLElement
    expect(sessionTab).toBeTruthy()
    fireEvent.click(sessionTab)

    // setActive should have been called with the session tab id
    expect(tabs.setActive).toHaveBeenCalledWith("tab-session")
  })

  test("closing process tab allows closing another tab afterward", async () => {
    useReactiveTabs([
      { id: "tab-session", type: "session", title: "Session", directory: "/ws/main", closable: true },
      { id: "tab-process", type: "process", title: "Processes", directory: "/ws/main", closable: true },
      { id: "tab-terminal", type: "terminal", title: "Terminal", directory: "/ws/main", closable: true },
    ], "tab-process")

    const { container } = render(() => (
      <TopTabBar groupId="g-default" showSidebarToggle={false} />
    ))

    const closeButtons = () =>
      Array.from(container.querySelectorAll('button[aria-label="Close tab"]')) as HTMLButtonElement[]

    // Close the process tab
    fireEvent.click(closeButtons()[1]!)

    await waitFor(() => {
      expect(container.querySelector('[data-tab-id="tab-process"]')).toBeFalsy()
    })

    // Now close the session tab
    fireEvent.click(closeButtons()[0]!)

    await waitFor(() => {
      expect(container.querySelector('[data-tab-id="tab-session"]')).toBeFalsy()
    })

    // Both closes should have been called
    expect(tabs.close).toHaveBeenCalledTimes(2)
    expect(tabs.close).toHaveBeenNthCalledWith(1, "tab-process")
    expect(tabs.close).toHaveBeenNthCalledWith(2, "tab-session")

    // Only terminal tab remains
    expect(container.querySelector('[data-tab-id="tab-terminal"]')).toBeTruthy()
    expect(container.querySelectorAll("[data-tab-id]").length).toBe(1)
  })

  test("process tab close followed by rapid tab switch", async () => {
    useReactiveTabs([
      { id: "tab-session", type: "session", title: "Session", directory: "/ws/main", closable: true },
      { id: "tab-process", type: "process", title: "Processes", directory: "/ws/main", closable: true },
      { id: "tab-terminal", type: "terminal", title: "Terminal", directory: "/ws/main", closable: true },
    ], "tab-process")

    const { container } = render(() => (
      <TopTabBar groupId="g-default" showSidebarToggle={false} />
    ))

    const closeButtons = () =>
      Array.from(container.querySelectorAll('button[aria-label="Close tab"]')) as HTMLButtonElement[]

    // Close process tab then immediately click session tab (before microtask runs)
    fireEvent.click(closeButtons()[1]!)

    const sessionTab = container.querySelector('[data-tab-id="tab-session"]') as HTMLElement
    expect(sessionTab).toBeTruthy()
    fireEvent.click(sessionTab)

    // setActive should have been called (not blocked by closing state)
    expect(tabs.setActive).toHaveBeenCalledWith("tab-session")

    // Process tab should eventually disappear
    await waitFor(() => {
      expect(container.querySelector('[data-tab-id="tab-process"]')).toBeFalsy()
    })
  })

  test("when close does not remove the tab, the close button remains functional", async () => {
    const [items, setItems] = createSignal([
      { id: "tab-process", type: "process", title: "Processes", directory: "/ws/main", closable: true },
      { id: "tab-session", type: "session", title: "Session", directory: "/ws/main", closable: true },
    ])
    const [activeId, setActiveId] = createSignal<string | undefined>("tab-process")
    const [tabOrder] = createSignal(["tab-process", "tab-session"])

    tabs.items = items as any
    tabs.visualOrderedItems = items as any
    tabs.orderedItems = items as any
    tabs.order = tabOrder as any
    tabs.activeId = activeId as any
    tabs.active = () => items().find((t) => t.id === activeId())
    tabs.close = vi.fn((_tabId: string) => {
      // Intentionally do nothing — tab stays in items
    })
    tabs.setActive = vi.fn((id: string) => setActiveId(id))

    const { container } = render(() => (
      <TopTabBar groupId="g-default" showSidebarToggle={false} />
    ))

    const closeButtons = () =>
      Array.from(container.querySelectorAll('button[aria-label="Close tab"]')) as HTMLButtonElement[]

    fireEvent.click(closeButtons()[0]!)

    await waitFor(() => {
      expect(tabs.close).toHaveBeenCalledWith("tab-process")
    })

    // Click close again — should not be blocked by a stale guard
    tabs.close.mockClear()
    fireEvent.click(closeButtons()[0]!)

    await waitFor(() => {
      expect(tabs.close).toHaveBeenCalledWith("tab-process")
    })
  })

  test("process tab stays in DOM when close does not remove it from items", async () => {
    const [items, setItems] = createSignal([
      { id: "tab-session", type: "session", title: "Session", directory: "/ws/main", closable: true },
      { id: "tab-process", type: "process", title: "Processes", directory: "/ws/main", closable: true },
    ])
    const [activeId, setActiveId] = createSignal<string | undefined>("tab-process")
    const ordered = () => items()

    tabs.items = items as any
    tabs.visualOrderedItems = ordered as any
    tabs.orderedItems = ordered as any
    tabs.order = () => items().map((t) => t.id)
    tabs.activeId = activeId as any
    tabs.active = () => items().find((t) => t.id === activeId())
    tabs.close = vi.fn((_tabId: string) => {
      setActiveId("tab-session")
    })
    tabs.setActive = vi.fn((id: string) => setActiveId(id))

    const { container } = render(() => (
      <TopTabBar groupId="g-default" showSidebarToggle={false} />
    ))

    const closeButtons = () =>
      Array.from(container.querySelectorAll('button[aria-label="Close tab"]')) as HTMLButtonElement[]

    fireEvent.click(closeButtons()[1]!)

    await waitFor(() => {
      expect(tabs.close).toHaveBeenCalledWith("tab-process")
    })

    // Process tab stays in DOM since close didn't remove it from items
    expect(container.querySelector('[data-tab-id="tab-process"]')).toBeTruthy()

    // Other tabs remain interactive
    const sessionTab = container.querySelector('[data-tab-id="tab-session"]') as HTMLElement
    expect(sessionTab).toBeTruthy()
    fireEvent.click(sessionTab)
    expect(tabs.setActive).toHaveBeenCalledWith("tab-session")
  })

  test("after process tab close silently fails, other tabs can still be closed", async () => {
    const [items, setItems] = createSignal([
      { id: "tab-session", type: "session", title: "Session", directory: "/ws/main", closable: true },
      { id: "tab-process", type: "process", title: "Processes", directory: "/ws/main", closable: true },
      { id: "tab-terminal", type: "terminal", title: "Terminal", directory: "/ws/main", closable: true },
    ])
    const [activeId, setActiveId] = createSignal<string | undefined>("tab-process")
    const ordered = () => items()

    tabs.items = items as any
    tabs.visualOrderedItems = ordered as any
    tabs.orderedItems = ordered as any
    tabs.order = () => items().map((t) => t.id)
    tabs.activeId = activeId as any
    tabs.active = () => items().find((t) => t.id === activeId())
    // close fails silently ONLY for the process tab
    tabs.close = vi.fn((tabId: string) => {
      if (tabId === "tab-process") {
        setActiveId("tab-session")
        return
      }
      const current = items()
      const next = current.filter((t) => t.id !== tabId)
      setItems(next)
      if (activeId() === tabId) {
        const idx = current.findIndex((t) => t.id === tabId)
        const fallback = next[idx] ?? next[idx - 1] ?? next[0]
        setActiveId(fallback?.id)
      }
    })
    tabs.setActive = vi.fn((id: string) => setActiveId(id))

    const { container } = render(() => (
      <TopTabBar groupId="g-default" showSidebarToggle={false} />
    ))

    const closeButtons = () =>
      Array.from(container.querySelectorAll('button[aria-label="Close tab"]')) as HTMLButtonElement[]

    // Close the process tab (silently fails — tab stays in DOM)
    fireEvent.click(closeButtons()[1]!)

    await waitFor(() => {
      expect(tabs.close).toHaveBeenCalledWith("tab-process")
    })

    expect(container.querySelector('[data-tab-id="tab-process"]')).toBeTruthy()

    // Close the session tab (should work normally)
    fireEvent.click(closeButtons()[0]!)

    await waitFor(() => {
      expect(container.querySelector('[data-tab-id="tab-session"]')).toBeFalsy()
    })

    expect(tabs.close).toHaveBeenCalledTimes(2)
  })
})
