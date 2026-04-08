/**
 * Tab Empty State & Session Selection Tests
 *
 * Tests for:
 * 1. When all tabs are closed, activeTab should be undefined (empty state)
 * 2. Worktree default should be clearable so no phantom tabs get created
 * 3. Selecting an existing session from sidebar should create a tab with that sessionId
 * 4. Session select should reuse existing tab if one already exists for that session
 * 5. After closing all tabs, workspace/project context should be clear
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ensureLayoutMocked, getInitLayout } from "./_test-helper"

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

// ---------------------------------------------------------------------------
// Empty state after closing all tabs
// ---------------------------------------------------------------------------

describe("empty state when all tabs are closed", () => {
  test("closing the only tab leaves no active tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const tabs = api.groupTabs(g1)

      // Add a session tab then close it
      const tabId = tabs.addSession("/ws", "s1", "Session 1")
      expect(tabId).toBeTruthy()
      tabs.setActive(tabId)
      expect(api.select.groupActiveTab(g1)).toBeTruthy()

      // Close it
      tabs.close(tabId)

      // Should have no tabs left and no active tab
      expect(tabs.items()).toHaveLength(0)
      expect(api.select.groupActiveTab(g1)).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("closing all tabs leaves no active tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const tabs = api.groupTabs(g1)

      // Add multiple tabs
      const t1 = tabs.addSession("/ws", "s1", "Session 1")
      const t2 = tabs.addSession("/ws", "s2", "Session 2")
      const t3 = tabs.addTerminal("/ws", "pty-1", "Terminal 1")
      tabs.setActive(t1)

      // Close all
      tabs.close(t1)
      tabs.close(t2)
      tabs.close(t3)

      expect(tabs.items()).toHaveLength(0)
      expect(api.select.groupActiveTab(g1)).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("activeRenderTarget is undefined when no tabs exist", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const tabs = api.groupTabs(g1)

      // Add and close
      const tabId = tabs.addSession("/ws", "s1", "Session 1")
      tabs.setActive(tabId)
      tabs.close(tabId)

      expect(api.select.activeRenderTarget(g1)).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("worktree default can be cleared to null", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const wt = api.groupWorktree(g1)

      wt.setDefault("/ws")
      expect(wt.default()).toBe("/ws")

      wt.setDefault(null)
      expect(wt.default()).toBeNull()
    } finally {
      dispose()
    }
  })

  test("after closing all tabs and clearing worktree, group has clean empty state", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const tabs = api.groupTabs(g1)
      const wt = api.groupWorktree(g1)

      // Set up workspace and tabs
      wt.setDefault("/ws")
      const t1 = tabs.addSession("/ws", "s1", "Session 1")
      tabs.setActive(t1)

      // Close tab and clear workspace
      tabs.close(t1)
      wt.setDefault(null)

      expect(tabs.items()).toHaveLength(0)
      expect(api.select.groupActiveTab(g1)).toBeUndefined()
      expect(wt.default()).toBeNull()
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Session selection creates tabs
// ---------------------------------------------------------------------------

describe("session selection creates and activates tabs", () => {
  test("selecting a session creates a tab with correct sessionId", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const tabs = api.groupTabs(g1)

      // Simulate session select: add session tab and activate it
      const tabId = tabs.addSession("/ws", "existing-session-123", "My Session")
      expect(tabId).toBeTruthy()
      tabs.setActive(tabId)

      const active = api.select.groupActiveTab(g1)
      expect(active).toBeDefined()
      expect(active!.sessionId).toBe("existing-session-123")
      expect(active!.title).toBe("My Session")
      expect(active!.directory).toBe("/ws")
      expect(active!.type).toBe("session")
    } finally {
      dispose()
    }
  })

  test("activating a real session tab after a draft new tab keeps the active render target on the real tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const tabs = api.groupTabs(g1)

      const draft = tabs.addSession("/ws", "new", "New Session")
      tabs.setActive(draft)

      const real = tabs.addSession("/ws", "s-real", "Real Session")
      tabs.setActive(real)

      expect(tabs.items().map((tab: any) => tab.sessionId)).toEqual(["new", "s-real"])
      expect(api.select.groupActiveTab(g1)?.id).toBe(real)
      expect(api.select.groupActiveTab(g1)?.sessionId).toBe("s-real")
      expect(api.select.activeRenderTarget(g1)).toEqual({
        tabId: real,
        type: "session",
        directory: "/ws",
      })
    } finally {
      dispose()
    }
  })

  test("selecting same session twice should find existing tab via findSession", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const tabs = api.groupTabs(g1)

      // First select
      const t1 = tabs.addSession("/ws", "s1", "Session 1")
      tabs.setActive(t1)

      // Simulate second click on same session — should find existing
      const existing = tabs.findSession("/ws", "s1")
      expect(existing).toBeDefined()
      expect(existing!.id).toBe(t1)

      // Should not add a duplicate
      expect(tabs.items().filter((t: any) => t.sessionId === "s1")).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  test("selecting different session creates separate tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const tabs = api.groupTabs(g1)

      const t1 = tabs.addSession("/ws", "s1", "Session 1")
      const t2 = tabs.addSession("/ws", "s2", "Session 2")
      tabs.setActive(t2)

      expect(tabs.items()).toHaveLength(2)
      const active = api.select.groupActiveTab(g1)
      expect(active!.sessionId).toBe("s2")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// topTabs delegation for session select
// ---------------------------------------------------------------------------

describe("topTabs.addSession creates tab in focused group", () => {
  test("topTabs.addSession adds to focused group and can be activated", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id

      // Use topTabs (what handleSessionSelect uses)
      const tabId = api.topTabs.addSession("/ws", "sidebar-session", "Sidebar Session")
      expect(tabId).toBeTruthy()
      api.topTabs.setActive(tabId)

      const active = api.select.groupActiveTab(g1)
      expect(active).toBeDefined()
      expect(active!.sessionId).toBe("sidebar-session")
    } finally {
      dispose()
    }
  })

  test("topTabs.findSession finds tab added via topTabs", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.topTabs.addSession("/ws", "s1", "Session 1")
      const found = api.topTabs.findSession("/ws", "s1")
      expect(found).toBeDefined()
      expect(found!.sessionId).toBe("s1")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Tab close + re-select flow
// ---------------------------------------------------------------------------

describe("close all tabs then select session from sidebar", () => {
  test("can add and activate a session tab after all tabs were closed", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const tabs = api.groupTabs(g1)

      // Create and close a tab
      const t1 = tabs.addSession("/ws", "s1", "Session 1")
      tabs.setActive(t1)
      tabs.close(t1)
      expect(tabs.items()).toHaveLength(0)
      expect(api.select.groupActiveTab(g1)).toBeUndefined()

      // Now select a different session (simulates sidebar click)
      const t2 = tabs.addSession("/ws", "s2", "Session 2")
      tabs.setActive(t2)

      expect(tabs.items()).toHaveLength(1)
      const active = api.select.groupActiveTab(g1)
      expect(active).toBeDefined()
      expect(active!.sessionId).toBe("s2")
    } finally {
      dispose()
    }
  })

  test("selecting a session from a different workspace after closing tabs works", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const tabs = api.groupTabs(g1)

      // Work in /ws-a
      const t1 = tabs.addSession("/ws-a", "s1", "Session A")
      tabs.setActive(t1)
      tabs.close(t1)

      // Select session from /ws-b
      const t2 = tabs.addSession("/ws-b", "s2", "Session B")
      tabs.setActive(t2)

      const active = api.select.groupActiveTab(g1)
      expect(active).toBeDefined()
      expect(active!.sessionId).toBe("s2")
      expect(active!.directory).toBe("/ws-b")
    } finally {
      dispose()
    }
  })
})
