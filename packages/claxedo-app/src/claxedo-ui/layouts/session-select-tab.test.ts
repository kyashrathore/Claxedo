/**
 * Session Select → Tab Creation Integration Tests
 *
 * Tests the exact flow: user clicks a session in the sidebar → a tab should
 * appear in the tab bar. Exercises the real claxedo layout store with
 * reactive SolidJS computations that mirror what TopTabBar uses to render.
 *
 * These tests replicate the reactive memos from TopTabBar and GroupPanel
 * to verify that tabs appear in the "visibleTabs" list that drives DOM
 * rendering (<For each={visibleTabs()}>).
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { ensureLayoutMocked, getInitLayout } from "../context/_test-helper"
import type { TabItem } from "../context/claxedo-layout"
import { isGlobalTab, tabScopeDir as scopeDir } from "../context/claxedo-layout/types"

let initLayout: () => any

beforeAll(async () => {
  await ensureLayoutMocked()
  initLayout = getInitLayout()
})

function createTestLayout() {
  let dispose!: () => void
  const api = createRoot((d) => {
    dispose = d
    return initLayout()
  })
  return { api, dispose }
}

/**
 * Simulate what TopTabBar computes to decide which tabs to render.
 * This mirrors lines 642-693 of top-tab-bar.tsx.
 *
 * DRIFT RISK: If top-tab-bar.tsx changes its visibleTabs/scope logic,
 * this mirror must be updated. Grep for "createVisibleTabs" if the
 * TopTabBar filtering changes.
 */
function createVisibleTabs(api: any, groupId: string) {
  const tabs = () => api.groupTabs(groupId)
  const wt = () => api.groupWorktree(groupId)
  const active = () => tabs().active()
  const pinned = () => wt().pinned()
  const selected = () => wt().default()
  const scope = () => {
    const tab = active()
    if (tab && (tab.type === "session" || tab.type === "review" || tab.type === "context" || tab.type === "file")) {
      return tab.directory
    }
    return selected()
  }
  const tabScopeDir = (tab: TabItem) => {
    return scopeDir(tab, scope())
  }
  const orderedTabs = () => tabs().visualOrderedItems()
  const scopeFilteredTabs = () => {
    const pin = pinned()
    if (pin) return orderedTabs().filter((t: TabItem) => t.pinned || isGlobalTab(t) || tabScopeDir(t) === pin)
    const dir = scope()
    if (!dir) return orderedTabs()
    return orderedTabs().filter((t: TabItem) => {
      if (isGlobalTab(t)) return true
      if (t.pinned) return true
      if (t.type === "review" || t.type === "context" || t.type === "file") return tabScopeDir(t) === dir
      return true
    })
  }
  const visibleTabs = () => {
    const list = scopeFilteredTabs()
    const groups = new Map<string | undefined, TabItem[]>()
    for (const tab of list) {
      const dir = tabScopeDir(tab)
      const existing = groups.get(dir)
      if (existing) {
        existing.push(tab)
        continue
      }
      groups.set(dir, [tab])
    }
    return Array.from(groups.values()).flat()
  }

  return { visibleTabs, active, tabs, wt }
}

/**
 * Simulate what GroupPanel computes for currentDir/projectName/workspaceName.
 * This mirrors lines 737-755 of rail-layout.tsx.
 *
 * DRIFT RISK: If rail-layout.tsx GroupPanel changes its currentDir
 * derivation, this mirror must be updated.
 */
function createGroupPanelState(api: any, groupId: string) {
  const tabs = () => api.groupTabs(groupId)
  const wt = () => api.groupWorktree(groupId)
  const activeTab = () => api.select.groupActiveTab(groupId)
  const currentDir = () =>
    activeTab()?.directory ?? (tabs().items().length > 0 ? (wt().pinned() ?? wt().default()) : undefined)

  return { activeTab, currentDir, tabs, wt }
}

// ---------------------------------------------------------------------------
// Selecting a session from sidebar should create a visible tab
// ---------------------------------------------------------------------------

describe("session select from sidebar creates a visible tab", () => {
  test("clicking a session adds it to visibleTabs (what TopTabBar renders)", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const { visibleTabs, active } = createVisibleTabs(api, g1)

      // Initially no tabs
      expect(visibleTabs()).toHaveLength(0)
      expect(active()).toBeUndefined()

      // Simulate handleSessionSelect: topTabs.addSession + topTabs.setActive
      const tabId = api.topTabs.addSession("/ws", "session-abc", "My Chat Session")
      api.topTabs.setActive(tabId)

      // Tab should now be visible — this is what <For each={visibleTabs()}> iterates
      expect(visibleTabs()).toHaveLength(1)
      expect(visibleTabs()[0].id).toBe(tabId)
      expect(visibleTabs()[0].sessionId).toBe("session-abc")
      expect(visibleTabs()[0].title).toBe("My Chat Session")
      expect(visibleTabs()[0].type).toBe("session")

      // Active tab should be set
      expect(active()).toBeDefined()
      expect(active()!.id).toBe(tabId)
    } finally {
      dispose()
    }
  })

  test("clicking a second session adds another visible tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const { visibleTabs, active } = createVisibleTabs(api, g1)

      const t1 = api.topTabs.addSession("/ws", "s1", "Session 1")
      api.topTabs.setActive(t1)
      expect(visibleTabs()).toHaveLength(1)

      const t2 = api.topTabs.addSession("/ws", "s2", "Session 2")
      api.topTabs.setActive(t2)
      expect(visibleTabs()).toHaveLength(2)

      // Second session is active
      expect(active()!.sessionId).toBe("s2")
      // Both tabs visible
      expect(visibleTabs().map((t: TabItem) => t.sessionId)).toEqual(["s1", "s2"])
    } finally {
      dispose()
    }
  })

  test("clicking same session again reuses existing tab (no duplicate)", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const { visibleTabs } = createVisibleTabs(api, g1)

      const t1 = api.topTabs.addSession("/ws", "s1", "Session 1")
      api.topTabs.setActive(t1)

      // Second click on same session
      const t2 = api.topTabs.addSession("/ws", "s1", "Session 1")
      api.topTabs.setActive(t2)

      // Should still be 1 tab, same id
      expect(visibleTabs()).toHaveLength(1)
      expect(t1).toBe(t2)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Empty state: no tabs → no workspace/project display
// ---------------------------------------------------------------------------

describe("empty state after closing all tabs", () => {
  test("closing all tabs leaves visibleTabs empty", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const { visibleTabs, active } = createVisibleTabs(api, g1)

      const t1 = api.topTabs.addSession("/ws", "s1", "Session 1")
      api.topTabs.setActive(t1)
      expect(visibleTabs()).toHaveLength(1)

      // Close the tab
      api.groupTabs(g1).close(t1)

      expect(visibleTabs()).toHaveLength(0)
      expect(active()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("currentDir is undefined when no tabs exist (hides workspace selector)", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const { currentDir, activeTab } = createGroupPanelState(api, g1)

      // Set a default workspace (simulates what happens on project select)
      api.groupWorktree(g1).setDefault("/ws")

      // Add and close a tab
      const t1 = api.groupTabs(g1).addSession("/ws", "s1", "Session 1")
      api.groupTabs(g1).setActive(t1)
      expect(currentDir()).toBe("/ws")

      api.groupTabs(g1).close(t1)

      // With no tabs, currentDir should be undefined (workspace selector hidden)
      expect(activeTab()).toBeUndefined()
      expect(currentDir()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("selecting a session after empty state restores currentDir", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const { currentDir, activeTab } = createGroupPanelState(api, g1)

      api.groupWorktree(g1).setDefault("/ws")

      // Add, activate, close
      const t1 = api.groupTabs(g1).addSession("/ws", "s1", "Session 1")
      api.groupTabs(g1).setActive(t1)
      api.groupTabs(g1).close(t1)
      expect(currentDir()).toBeUndefined()

      // Select a new session from sidebar
      const t2 = api.topTabs.addSession("/ws", "s2", "Session 2")
      api.topTabs.setActive(t2)

      expect(activeTab()).toBeDefined()
      expect(activeTab()!.sessionId).toBe("s2")
      expect(currentDir()).toBe("/ws")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Session select from empty state (the main bug scenario)
// ---------------------------------------------------------------------------

describe("session select from empty state (main bug)", () => {
  test("from zero tabs: sidebar session click → tab appears in visibleTabs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const { visibleTabs, active } = createVisibleTabs(api, g1)
      const { currentDir } = createGroupPanelState(api, g1)

      // Start from truly empty state
      expect(visibleTabs()).toHaveLength(0)
      expect(active()).toBeUndefined()
      expect(currentDir()).toBeUndefined()

      // Simulate exact handleSessionSelect flow:
      // 1. topTabs.addSession(workspaceDir, sessionId, title)
      // 2. topTabs.setActive(id)
      const tabId = api.topTabs.addSession("/project/main", "ses-123", "Who is Modi?")
      expect(tabId).toBeTruthy()
      api.topTabs.setActive(tabId)

      // Tab MUST appear in visibleTabs (drives DOM rendering)
      expect(visibleTabs()).toHaveLength(1)
      expect(visibleTabs()[0].id).toBe(tabId)
      expect(visibleTabs()[0].sessionId).toBe("ses-123")
      expect(visibleTabs()[0].title).toBe("Who is Modi?")

      // Active tab must be set
      expect(active()!.id).toBe(tabId)

      // currentDir must reflect the session's workspace
      expect(currentDir()).toBe("/project/main")
    } finally {
      dispose()
    }
  })

  test("from empty: select, close, select different session", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const { visibleTabs, active } = createVisibleTabs(api, g1)

      // Select first session
      const t1 = api.topTabs.addSession("/ws", "s1", "First")
      api.topTabs.setActive(t1)
      expect(visibleTabs()).toHaveLength(1)

      // Close it
      api.groupTabs(g1).close(t1)
      expect(visibleTabs()).toHaveLength(0)
      expect(active()).toBeUndefined()

      // Select different session
      const t2 = api.topTabs.addSession("/ws", "s2", "Second")
      api.topTabs.setActive(t2)

      expect(visibleTabs()).toHaveLength(1)
      expect(visibleTabs()[0].sessionId).toBe("s2")
      expect(active()!.sessionId).toBe("s2")
    } finally {
      dispose()
    }
  })

  test("groupActiveTab tracks the selected session", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id

      expect(api.select.groupActiveTab(g1)).toBeUndefined()

      const tabId = api.topTabs.addSession("/ws", "s1", "Session 1")
      api.topTabs.setActive(tabId)

      const activeTab = api.select.groupActiveTab(g1)
      expect(activeTab).toBeDefined()
      expect(activeTab!.sessionId).toBe("s1")
      expect(activeTab!.id).toBe(tabId)
    } finally {
      dispose()
    }
  })
})
