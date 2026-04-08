import { describe, expect, test, vi, beforeEach } from "vitest"
import { closeTabLogic } from "./rail-layout-logic"

const platform = {
  platform: "desktop",
  os: "macos",
  quit: vi.fn(),
}

const dialog = {
  show: vi.fn(),
  close: vi.fn(),
}

const components = {
  Dialog: (props: any) => props.children,
  Button: (props: any) => props.children,
}

const tabsByGroup: Record<string, any> = {}

const makeTabs = (groupId: string) => {
  if (tabsByGroup[groupId]) return tabsByGroup[groupId]
  const tabs = {
    items: vi.fn(() => []),
    active: vi.fn(() => undefined),
    closeActive: vi.fn(),
  }
  tabsByGroup[groupId] = tabs
  return tabs
}

const claxedo = {
  split: {
    focusedId: vi.fn(() => "g1"),
  },
  groupTabs: (groupId: string) => makeTabs(groupId),
  multiPane: {
    activeLayout: vi.fn(),
    leafIds: vi.fn(),
    closeLeaf: vi.fn(),
  },
  select: {
    visibleGroups: vi.fn(() => [{ id: "g1" }]),
  },
}

describe("closeTabLogic", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.keys(tabsByGroup).forEach(key => delete tabsByGroup[key])
  })

  test("closes focused pane if multiple panes exist in the active tab", () => {
    const g1Tabs = makeTabs("g1")
    const activeTab = { id: "t1" }
    g1Tabs.active.mockReturnValue(activeTab)
    claxedo.multiPane.activeLayout.mockReturnValue({ focus: "leaf1" })
    claxedo.multiPane.leafIds.mockReturnValue(["leaf1", "leaf2"])

    closeTabLogic(claxedo as any, platform as any, dialog as any, components as any)

    expect(claxedo.multiPane.closeLeaf).toHaveBeenCalledWith("t1", "leaf1")
    expect(g1Tabs.closeActive).not.toHaveBeenCalled()
  })

  test("closes active tab if only one pane exists", () => {
    const g1Tabs = makeTabs("g1")
    const activeTab = { id: "t1" }
    g1Tabs.active.mockReturnValue(activeTab)
    claxedo.multiPane.activeLayout.mockReturnValue({ focus: "leaf1" })
    claxedo.multiPane.leafIds.mockReturnValue(["leaf1"])
    g1Tabs.items.mockReturnValue([activeTab])

    closeTabLogic(claxedo as any, platform as any, dialog as any, components as any)

    expect(claxedo.multiPane.closeLeaf).not.toHaveBeenCalled()
    expect(g1Tabs.closeActive).toHaveBeenCalled()
  })

  test("shows quit confirmation dialog on desktop if no tabs are left", () => {
    const g1Tabs = makeTabs("g1")
    g1Tabs.active.mockReturnValue(undefined)
    g1Tabs.items.mockReturnValue([])
    claxedo.select.visibleGroups.mockReturnValue([{ id: "g1" }])
    platform.platform = "desktop"

    closeTabLogic(claxedo as any, platform as any, dialog as any, components as any)

    expect(dialog.show).toHaveBeenCalled()
    expect(g1Tabs.closeActive).not.toHaveBeenCalled()
  })

  test("does nothing if no tabs left and NOT on desktop", () => {
    const g1Tabs = makeTabs("g1")
    g1Tabs.active.mockReturnValue(undefined)
    g1Tabs.items.mockReturnValue([])
    claxedo.select.visibleGroups.mockReturnValue([{ id: "g1" }])
    platform.platform = "web"

    closeTabLogic(claxedo as any, platform as any, dialog as any, components as any)

    expect(dialog.show).not.toHaveBeenCalled()
    expect(g1Tabs.closeActive).not.toHaveBeenCalled()
  })
})
