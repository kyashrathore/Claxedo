/**
 * Split Panel State Isolation Tests
 *
 * Verifies that operations on one split group (tabs, terminals, sessions,
 * badges, agent status, layout) never pollute the other group's state.
 *
 * Strategy: mock persisted + createSimpleContext, capture the init function,
 * and call it inside createRoot to get the real store API.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { createEffect, createRoot, on } from "solid-js"
import { ensureLayoutMocked, getInitLayout } from "./_test-helper"

let initLayout: () => any

beforeAll(async () => {
  await ensureLayoutMocked()
  initLayout = getInitLayout()
})

/** Create a fresh layout store inside a SolidJS root for reactive tracking. */
function createTestLayout() {
  let dispose!: () => void
  const api = createRoot((d) => {
    dispose = d
    return initLayout()
  })
  return { api, dispose }
}

/** Split into two groups and return their IDs + tab accessors. */
function splitInto2(api: any) {
  api.split.toggle()
  const groups = api.split.groups()
  expect(groups).toHaveLength(2)
  const g1 = groups[0].id
  const g2 = groups[1].id
  return {
    g1,
    g2,
    tabs1: api.groupTabs(g1),
    tabs2: api.groupTabs(g2),
  }
}

// ---------------------------------------------------------------------------
// Tab isolation
// ---------------------------------------------------------------------------

describe("findTabGroup", () => {
  test("identifies which group a tab belongs to", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      const id1 = tabs1.addSession("/ws", "s1", "S1")
      const id2 = tabs2.addSession("/ws", "s2", "S2")

      expect(api.findTabGroup(id1)).toBe(g1)
      expect(api.findTabGroup(id2)).toBe(g2)
    } finally {
      dispose()
    }
  })

  test("returns undefined for nonexistent tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      splitInto2(api)
      expect(api.findTabGroup("nonexistent")).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// patchTab (cross-group)
// ---------------------------------------------------------------------------

describe("patchTab", () => {
  test("patches tab in any group by ID", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const id1 = tabs1.addSession("/ws", "s1", "S1")
      const id2 = tabs2.addSession("/ws", "s2", "S2")

      // patchTab targets by ID across all groups
      api.patchTab(id2, { title: "Patched" })

      expect(tabs1.items().find((t: any) => t.sessionId === "s1")?.title).toBe("S1")
      expect(tabs2.items().find((t: any) => t.sessionId === "s2")?.title).toBe("Patched")
    } finally {
      dispose()
    }
  })
})

describe("selector and command surface", () => {
  test("visibleGroups selector follows focused group when split is hidden", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)
      tabs1.addSession("/ws-a", "s1", "S1")
      tabs2.addSession("/ws-b", "s2", "S2")

      api.dispatch({ type: "SplitFocusRequested", groupId: g2 })
      api.dispatch({ type: "SplitToggleRequested" })

      const visible = api.select.visibleGroups().map((group: any) => group.id)
      expect(visible).toEqual([g2])

      // Restore split for sanity and ensure selector tracks both groups again.
      api.dispatch({ type: "SplitToggleRequested" })
      const all = api.select.visibleGroups().map((group: any) => group.id)
      expect(all).toEqual([g1, g2])
    } finally {
      dispose()
    }
  })

  test("groupActiveTab selector falls back to pinned workspace tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const a = tabs1.addSession("/ws-a", "s-a", "A")
      const b = tabs1.addSession("/ws-b", "s-b", "B")

      tabs1.setActive(b)
      api.groupWorktree(g1).setPinned("/ws-a")

      expect(tabs1.activeId()).toBe(b)
      expect(api.select.groupActiveTab(g1)?.id).toBe(a)
      expect(api.select.activeRenderTarget(g1)?.tabId).toBe(a)
    } finally {
      dispose()
    }
  })

  test("dispatch routes split and tab mutation commands", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)
      const tabId = tabs1.addSession("/ws", "s1", "S1")
      tabs1.addSession("/ws", "s-keep", "Keep")

      api.dispatch({ type: "TabMoveAcrossGroupsRequested", tabId, fromGroupId: g1, toGroupId: g2 })
      expect(tabs1.items().some((tab: any) => tab.id === tabId)).toBe(false)
      expect(tabs2.items().some((tab: any) => tab.id === tabId)).toBe(true)

      api.dispatch({ type: "TabActivateRequested", groupId: g2, tabId })
      expect(tabs2.activeId()).toBe(tabId)

      api.dispatch({ type: "TabCloseRequested", groupId: g2, tabId })
      expect(tabs2.items().some((tab: any) => tab.id === tabId)).toBe(false)

      api.dispatch({ type: "SplitFocusRequested", groupId: g2 })
      expect(api.split.focusedId()).toBe(g2)

      api.dispatch({ type: "SplitGroupCloseRequested", groupId: g2 })
      expect(api.split.groups()).toHaveLength(1)
      expect(api.split.groups()[0].id).toBe(g1)
    } finally {
      dispose()
    }
  })

  test("dispatch routes group worktree and process pane commands", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)

      api.dispatch({ type: "GroupWorktreeDefaultSetRequested", groupId: g1, directory: "/ws-main" })
      api.dispatch({ type: "GroupWorktreePinnedSetRequested", groupId: g1, directory: "/ws-main" })

      expect(api.groupWorktree(g1).default()).toBe("/ws-main")
      expect(api.groupWorktree(g1).pinned()).toBe("/ws-main")

      api.dispatch({ type: "ProcessPaneTargetSetRequested", directory: "/ws-main" })
      expect(api.processPane.targetDirectory()).toBe("/ws-main")

      // No process tab exists yet — isActive starts false.
      expect(api.processPane.isActive()).toBe(false)

      // Explicitly add a process tab (no longer auto-inserted).
      // addProcess sets it active immediately.
      api.groupTabs(g1).addProcess("/ws-main")
      expect(api.processPane.isActive()).toBe(true)

      // Toggling a different workspace target does not fabricate or retarget a process tab.
      api.dispatch({ type: "ProcessPaneToggleRequested", directory: "/ws-alt" })
      expect(api.processPane.targetDirectory()).toBe("/ws-alt")
      expect(api.processPane.isActive()).toBe(true)
      expect(api.groupTabs(g1).items().find((tab: any) => tab.type === "process")?.directory).toBe("/ws-main")

      api.dispatch({ type: "ProcessPaneCrashFlagSetRequested", value: true })
      expect(api.processPane.crashedWhileClosed()).toBe(true)
      api.dispatch({ type: "ProcessPaneCrashFlagSetRequested", value: false })
      expect(api.processPane.crashedWhileClosed()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("process tab stays anchored when the group default workspace changes", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)
      const tabs = api.groupTabs(g1)
      const wt = api.groupWorktree(g1)

      wt.setDefault("/ws-main")
      const processId = tabs.addProcess("/ws-main")
      const initial = tabs.items().find((tab: any) => tab.id === processId)
      expect(initial?.directory).toBe("/ws-main")

      wt.setDefault("/ws-alt")

      const process = tabs.items().find((tab: any) => tab.id === processId)
      expect(process?.directory).toBe("/ws-main")
      expect(process?.pinned).toBeFalsy()
    } finally {
      dispose()
    }
  })

  test("process tabs are tracked per workspace directory", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)
      const tabs = api.groupTabs(g1)

      const main = tabs.addProcess("/ws-main")
      const feature = tabs.addProcess("/ws-feature")

      expect(main).not.toBe(feature)
      expect(tabs.items().filter((tab: any) => tab.type === "process").map((tab: any) => tab.directory)).toEqual([
        "/ws-main",
        "/ws-feature",
      ])

      api.dispatch({ type: "ProcessPaneOpenRequested", directory: "/ws-main" })
      expect(tabs.activeId()).toBe(main)
      expect(api.processPane.isActive("/ws-main")).toBe(true)
      expect(api.processPane.isActive("/ws-feature")).toBe(false)

      api.dispatch({ type: "ProcessPaneOpenRequested", directory: "/ws-feature" })
      expect(tabs.activeId()).toBe(feature)
      expect(api.processPane.isActive("/ws-main")).toBe(false)
      expect(api.processPane.isActive("/ws-feature")).toBe(true)
    } finally {
      dispose()
    }
  })

  test("legacy process tab resolves to the requested workspace before opening", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)
      const tabs = api.groupTabs(g1)

      const sid = tabs.addSession("/ws-main", "s-main", "Main")
      const id = tabs.add({
        type: "process",
        directory: "__process__",
        title: "Processes",
        closable: false,
        pinned: true,
      })
      tabs.setActive(sid)
      api.dispatch({ type: "ProcessPaneOpenRequested", directory: "/ws-main" })

      const tab = tabs.items().find((item: any) => item.id === id)
      expect(tab?.directory).toBe("/ws-main")
      expect(tabs.activeId()).toBe(id)
      expect(api.groupWorktree(g1).default()).toBe("/ws-main")
      expect(api.processPane.isActive("/ws-main")).toBe(true)
    } finally {
      dispose()
    }
  })

  test("process sentinel does not become the group default", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)
      const tabs = api.groupTabs(g1)

      tabs.add({
        type: "process",
        directory: "__process__",
        title: "Processes",
        closable: false,
        pinned: true,
      })

      expect(api.groupWorktree(g1).default()).toBeNull()

      tabs.addSession("/ws-main", "new", "New Session")
      expect(api.groupWorktree(g1).default()).toBe("/ws-main")
    } finally {
      dispose()
    }
  })

  test("closing the last real tab does not replace the group default with a process sentinel", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)
      const tabs = api.groupTabs(g1)

      const sid = tabs.addSession("/ws-main", "s-main", "Main")
      const pid = tabs.add({
        type: "process",
        directory: "__process__",
        title: "Processes",
        closable: false,
        pinned: true,
      })

      tabs.setActive(pid)
      tabs.close(sid)

      expect(api.groupWorktree(g1).default()).toBe("/ws-main")
    } finally {
      dispose()
    }
  })

  test("groupTabs wrappers keep tab navigation behavior", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const a = tabs1.addSession("/ws", "s1", "S1")
      const b = tabs1.addSession("/ws", "s2", "S2")

      api.groupTabs(g1).setActive(a)
      expect(api.groupTabs(g1).activeId()).toBe(a)

      api.groupTabs(g1).activateNext()
      expect(api.groupTabs(g1).activeId()).toBe(b)

      api.groupTabs(g1).activatePrevious()
      expect(api.groupTabs(g1).activeId()).toBe(a)

      api.groupTabs(g1).closeActive()
      expect(
        api
          .groupTabs(g1)
          .items()
          .some((tab: any) => tab.id === a),
      ).toBe(false)
    } finally {
      dispose()
    }
  })

  test("dispatch routes tab creation and update commands", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)

      const a = api.dispatch({
        type: "SessionTabAddRequested",
        groupId: g1,
        directory: "/ws",
        sessionId: "s1",
        title: "Session 1",
      })

      expect(typeof a).toBe("string")
      expect(a).toBeTruthy()

      api.dispatch({ type: "TabTitleUpdateRequested", groupId: g1, tabId: a as string, title: "Renamed" })
      api.dispatch({
        type: "TabBadgeUpdateRequested",
        groupId: g1,
        tabId: a as string,
        badge: { additions: 2, deletions: 1 },
      })
      api.dispatch({ type: "TabPatchRequested", groupId: g1, tabId: a as string, patch: { done: true } })

      const b = api.dispatch({
        type: "SessionTabAddRequested",
        groupId: g1,
        directory: "/ws",
        sessionId: "s2",
        title: "Session 2",
      })

      expect(typeof b).toBe("string")
      expect(b).toBeTruthy()

      api.dispatch({ type: "TabMoveWithinGroupRequested", groupId: g1, tabId: b as string, toIndex: 0 })
      api.dispatch({ type: "TabActivateByIndexRequested", groupId: g1, index: 0 })
      expect(api.groupTabs(g1).activeId()).toBe(b)

      api.dispatch({ type: "TabCloseRequested", groupId: g1, tabId: b as string })
      expect(
        api
          .groupTabs(g1)
          .items()
          .some((tab: any) => tab.id === b),
      ).toBe(false)

      api.dispatch({ type: "TabReopenLastRequested", groupId: g1 })
      expect(
        api
          .groupTabs(g1)
          .items()
          .some((tab: any) => tab.id === b),
      ).toBe(true)

      const first = api
        .groupTabs(g1)
        .items()
        .find((tab: any) => tab.id === a)
      expect(first?.title).toBe("Renamed")
      expect(first?.badge).toEqual({ additions: 2, deletions: 1 })
      expect(first?.done).toBe(true)
    } finally {
      dispose()
    }
  })

  test("dispatch accepts RouteIntentReceived as adapter event", () => {
    const { api, dispose } = createTestLayout()
    try {
      const focused = api.split.focusedId()
      api.dispatch({
        type: "RouteIntentReceived",
        intent: {
          workspaceId: "/ws",
          tabId: "tab-1",
          sessionId: "s-1",
          pageId: undefined,
        },
      })
      expect(api.split.focusedId()).toBe(focused)
    } finally {
      dispose()
    }
  })

  test("multiPane selectors expose leaf geometry and split handles", () => {
    const { api, dispose } = createTestLayout()
    try {
      const tabId = api.topTabs.addSession("/ws", "s1", "Session 1")
      const first = api.select.multiPaneLeafView(tabId)

      expect(first).toHaveLength(1)
      expect(first[0].focused).toBe(true)
      expect(first[0].rect.top).toBe(0)
      expect(first[0].rect.left).toBe(0)
      expect(first[0].rect.width).toBe(1)
      expect(first[0].rect.height).toBe(1)

      api.dispatch({
        type: "PaneSplitRequested",
        tabId,
        leafId: first[0].id,
        dir: "v",
        content: {
          type: "session",
          directory: "/ws",
          sessionId: "new",
          title: "Session",
        },
      })

      const next = api.select.multiPaneLeafView(tabId)
      expect(next).toHaveLength(2)
      expect(api.select.multiPaneSplitHandles(tabId)).toHaveLength(1)

      api.dispatch({
        type: "PaneSplitRequested",
        tabId,
        leafId: next[0].id,
        dir: "h",
      })

      const third = api.select.multiPaneLeafView(tabId)
      expect(third).toHaveLength(3)
      expect(third.some((leaf: any) => leaf.title === "Empty")).toBe(true)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Terminal creation coordination
// ---------------------------------------------------------------------------

describe("terminal creation coordination", () => {
  test("requestCreate sets pendingGroupId to requested group", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)

      api.terminal.requestCreate("/ws", undefined, undefined, g1)

      expect(api.terminal.pendingGroupId()).toBe(g1)
      expect(api.terminal.pendingDir()).toBe("/ws")
      expect(api.terminal.creating()).toBe(1)
      expect(api.terminal.creatingGroupId()).toBe(g1)
    } finally {
      dispose()
    }
  })

  test("creatingGroupId only targets requested group", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2 } = splitInto2(api)

      api.terminal.requestCreate("/ws", undefined, undefined, g1)

      expect(api.terminal.creatingGroupId()).toBe(g1)
      expect(api.terminal.creatingGroupId()).not.toBe(g2)
    } finally {
      dispose()
    }
  })

  test("consumePendingCommand returns correct groupId and clears", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g2 } = splitInto2(api)

      api.terminal.requestCreate("/ws", "ls -la", "Agent", g2)

      const consumed = api.terminal.consumePendingCommand()

      expect(consumed.groupId).toBe(g2)
      expect(consumed.command).toBe("ls -la")
      expect(consumed.title).toBe("Agent")
      expect(consumed.directory).toBe("/ws")

      // Should be cleared after consumption
      expect(api.terminal.pendingGroupId()).toBeUndefined()
      expect(api.terminal.pendingCommand()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("created() clears creatingGroupId when counter reaches 0", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)

      api.terminal.requestCreate("/ws", undefined, undefined, g1)
      expect(api.terminal.creating()).toBe(1)
      expect(api.terminal.creatingGroupId()).toBe(g1)

      api.terminal.created()

      expect(api.terminal.creating()).toBe(0)
      expect(api.terminal.creatingGroupId()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("multiple creates: creatingGroupId cleared only at 0", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2 } = splitInto2(api)

      api.terminal.requestCreate("/ws", undefined, undefined, g1)
      api.terminal.requestCreate("/ws", undefined, undefined, g2)

      expect(api.terminal.creating()).toBe(2)
      // Note: creatingGroupId is set to the LAST requestCreate's group
      expect(api.terminal.creatingGroupId()).toBe(g2)

      api.terminal.created()
      expect(api.terminal.creating()).toBe(1)
      // Not yet 0, so groupId is still set
      expect(api.terminal.creatingGroupId()).toBe(g2)

      api.terminal.created()
      expect(api.terminal.creating()).toBe(0)
      expect(api.terminal.creatingGroupId()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("clearPendingCreate resets all pending state", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)

      api.terminal.requestCreate("/ws", "echo hi", "Agent", g1)
      api.terminal.clearPendingCreate()

      expect(api.terminal.pendingCreate()).toBe(0)
      expect(api.terminal.pendingCommand()).toBeUndefined()
      expect(api.terminal.pendingDir()).toBeUndefined()
      expect(api.terminal.pendingGroupId()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("queueCreateForTab stores per-tab create request and consumes once", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)
      api.terminal.queueCreateForTab("tab-1", "/ws", "claude", "Claude", g1, "pty-old")

      const peek = api.terminal.peekCreateForTab("tab-1")
      expect(peek?.tabId).toBe("tab-1")
      expect(peek?.directory).toBe("/ws")
      expect(peek?.command).toBe("claude")
      expect(peek?.title).toBe("Claude")
      expect(peek?.groupId).toBe(g1)
      expect(peek?.previousPtyId).toBe("pty-old")

      const consumed = api.terminal.consumeCreateForTab("tab-1")
      expect(consumed?.tabId).toBe("tab-1")
      expect(api.terminal.peekCreateForTab("tab-1")).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("clearCreateForTab removes queued request", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.queueCreateForTab("tab-2", "/ws")
      expect(api.terminal.peekCreateForTab("tab-2")?.tabId).toBe("tab-2")
      api.terminal.clearCreateForTab("tab-2")
      expect(api.terminal.peekCreateForTab("tab-2")).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Terminal pane isolation
// ---------------------------------------------------------------------------

describe("terminal pane isolation", () => {
  test("terminal ensure in tab A does not affect tab B", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.ensure("tab-a", "pty-1")

      expect(api.terminal.pane("tab-a")).toBeDefined()
      expect(api.terminal.ids("tab-a")).toEqual(["pty-1"])
      expect(api.terminal.pane("tab-b")).toBeUndefined()
      expect(api.terminal.ids("tab-b")).toEqual([])
    } finally {
      dispose()
    }
  })

  test("terminal split in tab A does not affect tab B", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.ensure("tab-a", "pty-1")
      api.terminal.ensure("tab-b", "pty-2")

      api.terminal.split({ tab: "tab-a", at: "pty-1", id: "pty-3", dir: "v" })

      expect(api.terminal.ids("tab-a")).toEqual(["pty-1", "pty-3"])
      expect(api.terminal.ids("tab-b")).toEqual(["pty-2"])
    } finally {
      dispose()
    }
  })

  test("terminal close in tab A does not affect tab B", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.ensure("tab-a", "pty-1")
      api.terminal.ensure("tab-b", "pty-2")
      api.terminal.split({ tab: "tab-a", at: "pty-1", id: "pty-3", dir: "v" })

      api.terminal.close({ tab: "tab-a", id: "pty-3" })

      expect(api.terminal.ids("tab-a")).toEqual(["pty-1"])
      expect(api.terminal.ids("tab-b")).toEqual(["pty-2"])
    } finally {
      dispose()
    }
  })

  test("terminal focus is per-tab and updating one tab does not change the other", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.ensure("tab-a", "pty-1")
      api.terminal.split({ tab: "tab-a", at: "pty-1", id: "pty-1b", dir: "v" })
      api.terminal.ensure("tab-b", "pty-2")

      api.terminal.setFocus("tab-a", "pty-1")
      api.terminal.setFocus("tab-b", "pty-2")

      // Focus is independent per tab
      expect(api.terminal.focus("tab-a")).toBe("pty-1")
      expect(api.terminal.focus("tab-b")).toBe("pty-2")

      // Changing focus within a split pane updates only that tab
      api.terminal.setFocus("tab-a", "pty-1b")
      expect(api.terminal.focus("tab-a")).toBe("pty-1b")
      expect(api.terminal.focus("tab-b")).toBe("pty-2")

      // Focus on a tab that was never ensured returns undefined
      expect(api.terminal.focus("tab-nonexistent")).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("terminal zoom is per-tab and can be cleared independently", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.ensure("tab-a", "pty-1")
      api.terminal.ensure("tab-b", "pty-2")

      api.terminal.setZoom("tab-a", "pty-1")
      api.terminal.setZoom("tab-b", "pty-2")

      // Zoom is independent per tab
      expect(api.terminal.zoom("tab-a")).toBe("pty-1")
      expect(api.terminal.zoom("tab-b")).toBe("pty-2")

      // Clearing zoom on tab-a does not affect tab-b
      api.terminal.setZoom("tab-a", undefined)
      expect(api.terminal.zoom("tab-a")).toBeUndefined()
      expect(api.terminal.zoom("tab-b")).toBe("pty-2")
    } finally {
      dispose()
    }
  })

  test("terminal owner is per-terminal-id and controls closeInTab guard behavior", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)
      const tabA = tabs1.addTerminal("/ws", "pty-1", "Terminal 1")
      const tabB = tabs2.addTerminal("/ws", "pty-2", "Terminal 2")

      api.terminal.ensure(tabA, "pty-1")
      api.terminal.ensure(tabB, "pty-2")
      api.terminal.own(tabA, "pty-1")
      api.terminal.own(tabB, "pty-2")

      // Owner links are per-terminal-id
      expect(api.terminal.owner("pty-1")).toBe(tabA)
      expect(api.terminal.owner("pty-2")).toBe(tabB)
      expect(api.terminal.owner("pty-3")).toBeUndefined()

      // closeInTab respects ownership: trying to close pty-2 from tabA is
      // rejected because pty-2's owner is tabB
      api.terminal.split({ tab: tabA, at: "pty-1", id: "pty-2", dir: "v" })
      api.terminal.own(tabB, "pty-2")
      api.terminal.closeInTab({
        tab: tabA,
        id: "pty-2",
        origin: { tabId: tabA, groupId: g1, hostId: `claxedo-tab-host-${tabA}` },
      })
      // pty-2 should still be in tab-a pane because owner mismatch blocked the close
      expect(api.terminal.ids(tabA)).toContain("pty-2")
    } finally {
      dispose()
    }
  })

  test("terminal disown removes only target", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.own("tab-a", "pty-1")
      api.terminal.own("tab-b", "pty-2")

      api.terminal.disown("pty-1")

      expect(api.terminal.owner("pty-1")).toBeUndefined()
      expect(api.terminal.owner("pty-2")).toBe("tab-b")
    } finally {
      dispose()
    }
  })

  test("terminal clear removes only state for that tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.ensure("tab-a", "pty-1")
      api.terminal.ensure("tab-b", "pty-2")
      api.terminal.own("tab-a", "pty-1")
      api.terminal.own("tab-b", "pty-2")
      api.terminal.setAgentStatus("pty-1", "working")
      api.terminal.setAgentStatus("pty-2", "working")

      api.terminal.clear("tab-a")

      expect(api.terminal.pane("tab-a")).toBeUndefined()
      expect(api.terminal.focus("tab-a")).toBeUndefined()
      expect(api.terminal.zoom("tab-a")).toBeUndefined()
      expect(api.terminal.owner("pty-1")).toBeUndefined()
      expect(api.terminal.agentStatus("pty-1")).toBe("idle")

      // tab-b should be completely unaffected
      expect(api.terminal.pane("tab-b")).toBeDefined()
      expect(api.terminal.ids("tab-b")).toEqual(["pty-2"])
      expect(api.terminal.owner("pty-2")).toBe("tab-b")
      expect(api.terminal.agentStatus("pty-2")).toBe("working")
    } finally {
      dispose()
    }
  })

  test("closing a terminal tab clears pane and owner state", () => {
    const { api, dispose } = createTestLayout()
    try {
      const tabId = api.topTabs.addTerminal("/ws", "pty-1", "Terminal 1")
      expect(tabId).toBeTruthy()
      if (!tabId) return

      api.terminal.ensure(tabId, "pty-1")
      api.terminal.own(tabId, "pty-1")
      api.terminal.setFocus(tabId, "pty-1")
      api.terminal.setZoom(tabId, "pty-1")

      expect(api.terminal.pane(tabId)).toBeDefined()
      expect(api.terminal.owner("pty-1")).toBe(tabId)

      api.topTabs.close(tabId)

      // Terminal tab close immediately drops pane state in multiPane,
      // and clears ownership/agent bookkeeping.
      expect(api.terminal.pane(tabId)).toBeUndefined()
      expect(api.terminal.focus(tabId)).toBeUndefined()
      expect(api.terminal.zoom(tabId)).toBeUndefined()
      expect(api.terminal.owner("pty-1")).toBeUndefined()
      expect(api.terminal.lifecycle("pty-1")).toBe("closing")
    } finally {
      dispose()
    }
  })

  test("closing terminal tab clears agent state even when owner link is missing", () => {
    const { api, dispose } = createTestLayout()
    try {
      const tabId = api.topTabs.addTerminal("/ws", "pty-1", "Terminal 1")
      expect(tabId).toBeTruthy()
      if (!tabId) return

      // Simulate race: pane exists but owner mapping was never written.
      api.terminal.ensure(tabId, "pty-1")
      api.terminal.setAgentStatus("pty-1", "working")

      expect(api.terminal.agentStatus("pty-1")).toBe("working")
      expect(api.terminal.owner("pty-1")).toBeUndefined()

      api.topTabs.close(tabId)

      // Pane is removed on close; agent state/lifecycle still clear correctly.
      expect(api.terminal.pane(tabId)).toBeUndefined()
      expect(api.terminal.agentStatus("pty-1")).toBe("idle")
      expect(api.terminal.lifecycle("pty-1")).toBe("closing")
    } finally {
      dispose()
    }
  })

  test("terminal resize in tab A does not affect tab B", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.ensure("tab-a", "pty-1")
      api.terminal.split({ tab: "tab-a", at: "pty-1", id: "pty-2", dir: "v" })
      api.terminal.ensure("tab-b", "pty-3")
      api.terminal.split({ tab: "tab-b", at: "pty-3", id: "pty-4", dir: "v" })

      api.terminal.resize({ tab: "tab-a", path: "", size: 0.3 })

      const paneA = api.terminal.pane("tab-a") as { size: number }
      const paneB = api.terminal.pane("tab-b") as { size: number }

      expect(paneA.size).toBeCloseTo(0.3)
      expect(paneB.size).toBeCloseTo(0.5) // default
    } finally {
      dispose()
    }
  })

  test("terminal swap in tab A does not affect tab B", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.ensure("tab-a", "pty-1")
      api.terminal.split({ tab: "tab-a", at: "pty-1", id: "pty-2", dir: "v" })
      api.terminal.ensure("tab-b", "pty-3")
      api.terminal.split({ tab: "tab-b", at: "pty-3", id: "pty-4", dir: "v" })

      api.terminal.swap({ tab: "tab-a", a: "pty-1", b: "pty-2" })

      // tab-a panes swapped
      const idsA = api.terminal.ids("tab-a")
      expect(idsA).toEqual(["pty-2", "pty-1"])

      // tab-b untouched
      const idsB = api.terminal.ids("tab-b")
      expect(idsB).toEqual(["pty-3", "pty-4"])
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Agent status isolation
// ---------------------------------------------------------------------------

describe("agent status isolation", () => {
  test("agent status is per terminal and aggregates correctly in getTabAgentStatus", () => {
    const { api, dispose } = createTestLayout()
    try {
      // Set up terminals in separate tabs
      api.terminal.ensure("tab-a", "pty-1")
      api.terminal.ensure("tab-b", "pty-2")

      api.terminal.setAgentStatus("pty-1", "working")
      api.terminal.setAgentStatus("pty-2", "permission")

      // Per-terminal status is correct
      expect(api.terminal.agentStatus("pty-1")).toBe("working")
      expect(api.terminal.agentStatus("pty-2")).toBe("permission")
      expect(api.terminal.agentStatus("pty-3")).toBe("idle")

      // Aggregated tab status reflects the individual terminal status
      const statusA = api.terminal.getTabAgentStatus("tab-a")
      expect(statusA.loading).toBe(true)
      expect(statusA.attention).toBe(false)

      const statusB = api.terminal.getTabAgentStatus("tab-b")
      expect(statusB.loading).toBe(false)
      expect(statusB.attention).toBe(true)

      // Tab with no ensured terminals shows idle aggregated status
      const statusEmpty = api.terminal.getTabAgentStatus("tab-nonexistent")
      expect(statusEmpty.loading).toBe(false)
      expect(statusEmpty.attention).toBe(false)
      expect(statusEmpty.done).toBe(false)
    } finally {
      dispose()
    }
  })

  test("clearAgentStatus only clears target terminal", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.setAgentStatus("pty-1", "working")
      api.terminal.setAgentStatus("pty-2", "permission")

      api.terminal.clearAgentStatus("pty-1")

      expect(api.terminal.agentStatus("pty-1")).toBe("idle")
      expect(api.terminal.agentStatus("pty-2")).toBe("permission")
    } finally {
      dispose()
    }
  })

  test("clearSeen only clears target terminal", () => {
    const { api, dispose } = createTestLayout()
    try {
      // setAgentStatus with non-idle marks the terminal as "seen"
      api.terminal.setAgentStatus("pty-1", "working")
      api.terminal.setAgentStatus("pty-2", "working")

      api.terminal.clearSeen("pty-1")

      // After clearSeen + idle, "done" should be false for pty-1
      api.terminal.setAgentStatus("pty-1", "idle")
      api.terminal.setAgentStatus("pty-2", "idle")

      // pty-1 was cleared before going idle -> not "done"
      // pty-2 was seen, went idle -> "done"
      api.terminal.ensure("tab-a", "pty-1")
      api.terminal.ensure("tab-b", "pty-2")

      const statusA = api.terminal.getTabAgentStatus("tab-a")
      const statusB = api.terminal.getTabAgentStatus("tab-b")

      expect(statusA.done).toBe(false)
      expect(statusB.done).toBe(true)
    } finally {
      dispose()
    }
  })

  test("tab agent status aggregates correctly within its tab only", () => {
    const { api, dispose } = createTestLayout()
    try {
      // Tab A has two terminals: one working, one idle
      api.terminal.ensure("tab-a", "pty-1")
      api.terminal.split({ tab: "tab-a", at: "pty-1", id: "pty-2", dir: "v" })

      // Tab B has one terminal: permission
      api.terminal.ensure("tab-b", "pty-3")

      api.terminal.setAgentStatus("pty-1", "working")
      api.terminal.setAgentStatus("pty-3", "permission")

      const statusA = api.terminal.getTabAgentStatus("tab-a")
      const statusB = api.terminal.getTabAgentStatus("tab-b")

      expect(statusA.loading).toBe(true)
      expect(statusA.attention).toBe(false)

      expect(statusB.loading).toBe(false)
      expect(statusB.attention).toBe(true)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Worktree isolation
// ---------------------------------------------------------------------------

describe("closeGroup deduplicates tabs on merge", () => {
  test("closeGroup deduplicates session tabs with same sessionId and directory", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      // Same session open in both groups (common when user splits with a session active)
      tabs1.addSession("/ws", "shared-session", "Session 1")
      tabs2.addSession("/ws", "shared-session", "Session 1")

      expect(tabs1.items()).toHaveLength(1)
      expect(tabs2.items()).toHaveLength(1)

      // Close group 2 → merge into group 1
      api.split.closeGroup(g2)

      // Should have 1 session tab (deduped), not 2 sessions
      const remaining = api.groupTabs(api.split.groups()[0].id)
      const sessionTabs = remaining.items().filter((t: any) => t.type === "session")
      expect(sessionTabs).toHaveLength(1)
      expect(sessionTabs[0].sessionId).toBe("shared-session")
    } finally {
      dispose()
    }
  })

  test("closeGroup keeps distinct sessions even with same sessionId in different directories", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      // Same sessionId but different directories → keep both
      tabs1.addSession("/ws-a", "s1", "Session 1")
      tabs2.addSession("/ws-b", "s1", "Session 1")

      api.split.closeGroup(g2)

      const remaining = api.groupTabs(api.split.groups()[0].id)
      // 2 session tabs (distinct directories, not deduped)
      const sessionTabs = remaining.items().filter((t: any) => t.type === "session")
      expect(sessionTabs).toHaveLength(2)
    } finally {
      dispose()
    }
  })

  test("closeGroup deduplicates terminal tabs with same terminalId", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      // Same terminal tab in both groups
      tabs1.addTerminal("/ws", "pty-1", "Terminal 1")
      tabs2.addTerminal("/ws", "pty-1", "Terminal 1")

      api.split.closeGroup(g2)

      const remaining = api.groupTabs(api.split.groups()[0].id)
      const terminalTabs = remaining.items().filter((t: any) => t.type === "terminal" && t.terminalId === "pty-1")
      expect(terminalTabs).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  test("closeGroup dedupe drops duplicate terminal tab and clears its pane state", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      const keep = tabs1.addTerminal("/ws", "pty-1", "Claude 1")
      const drop = tabs2.addTerminal("/ws", "pty-1", "Claude 1")

      api.terminal.ensure(keep, "pty-1")
      api.terminal.ensure(drop, "pty-1")
      api.terminal.setFocus(drop, "pty-1")
      api.terminal.setZoom(drop, "pty-1")

      expect(api.terminal.pane(drop)).toBeDefined()
      expect(api.terminal.focus(drop)).toBe("pty-1")
      expect(api.terminal.zoom(drop)).toBe("pty-1")

      api.split.closeGroup(g2)

      expect(api.split.groups()).toHaveLength(1)
      const remaining = api.groupTabs(g1).items()
      expect(remaining.some((t: any) => t.id === keep)).toBe(true)
      expect(remaining.some((t: any) => t.id === drop)).toBe(false)

      expect(api.terminal.pane(drop)).toBeUndefined()
      expect(api.terminal.focus(drop)).toBeUndefined()
      expect(api.terminal.zoom(drop)).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

describe("closeGroup clears stale creating state for removed groups", () => {
  test("closeGroup clears creating counter and groupId when removing group with pending create", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2 } = splitInto2(api)

      // Simulate unhandled requestCreate targeting g2 (no TerminalContentWrapperInner for g2)
      api.terminal.requestCreate("/ws", undefined, undefined, g2)

      expect(api.terminal.creating()).toBe(1)
      expect(api.terminal.creatingGroupId()).toBe(g2)

      // Close group 2 explicitly
      api.split.closeGroup(g2)

      // Creating state for removed group should be cleared
      expect(api.terminal.creating()).toBe(0)
      expect(api.terminal.creatingGroupId()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("after closeGroup, new requestCreate works without stale creating counter", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2 } = splitInto2(api)

      // Unhandled requestCreate targeting g2
      api.terminal.requestCreate("/ws", undefined, undefined, g2)
      expect(api.terminal.creating()).toBe(1)

      // Close group 2
      api.split.closeGroup(g2)

      // New requestCreate for remaining group
      const remainingId = api.split.groups()[0].id
      api.terminal.requestCreate("/ws", undefined, undefined, remainingId)

      // Simulate terminal created
      api.terminal.created()

      // Should be 0 — not stuck at 1 from old unhandled create
      expect(api.terminal.creating()).toBe(0)
      expect(api.terminal.creatingGroupId()).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

describe("terminal origin guard", () => {
  test("splitInTab ignores missing origin in split mode", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)
      const tabId = tabs1.addTerminal("/ws", "pty-1", "Terminal 1")
      api.terminal.ensure(tabId, "pty-1")

      api.terminal.splitInTab({ tab: tabId, at: "pty-1", id: "pty-2", dir: "v" })

      expect(api.terminal.ids(tabId)).toEqual(["pty-1"])
    } finally {
      dispose()
    }
  })

  test("splitInTab applies mutation when origin matches tab and group", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const tabId = tabs1.addTerminal("/ws", "pty-1", "Terminal 1")
      api.terminal.ensure(tabId, "pty-1")

      api.terminal.splitInTab({
        tab: tabId,
        at: "pty-1",
        id: "pty-2",
        dir: "v",
        origin: { tabId, groupId: g1, hostId: `claxedo-tab-host-${tabId}` },
      })

      expect(api.terminal.ids(tabId)).toEqual(["pty-1", "pty-2"])
    } finally {
      dispose()
    }
  })

  test("splitInTab ignores stale split target not in tab pane", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const tabId = tabs1.addTerminal("/ws", "pty-1", "Terminal 1")
      api.terminal.ensure(tabId, "pty-1")

      api.terminal.splitInTab({
        tab: tabId,
        at: "pty-stale",
        id: "pty-2",
        dir: "v",
        origin: { tabId, groupId: g1, hostId: `claxedo-tab-host-${tabId}` },
      })

      expect(api.terminal.ids(tabId)).toEqual(["pty-1"])
    } finally {
      dispose()
    }
  })

  test("closeInTab ignores owner mismatch against target tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)
      const tabA = tabs1.addTerminal("/ws", "pty-a", "Terminal A")
      const tabB = tabs2.addTerminal("/ws", "pty-b", "Terminal B")

      api.terminal.ensure(tabA, "pty-a")
      api.terminal.ensure(tabB, "pty-b")
      api.terminal.own(tabB, "pty-a")

      api.terminal.closeInTab({
        tab: tabA,
        id: "pty-a",
        origin: { tabId: tabA, groupId: g1, hostId: `claxedo-tab-host-${tabA}` },
      })

      expect(api.terminal.ids(tabA)).toEqual(["pty-a"])
      expect(api.terminal.owner("pty-a")).toBe(tabB)
      expect(api.findTabGroup(tabB)).toBe(g2)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Terminal lifecycle state machine
// ---------------------------------------------------------------------------

describe("terminal lifecycle state machine", () => {
  test("allows legal transitions creating -> attaching -> attached -> closing -> closed", () => {
    const { api, dispose } = createTestLayout()
    try {
      expect(api.terminal.transitionLifecycle("pty-1", "creating", "test")).toBe(true)
      expect(api.terminal.transitionLifecycle("pty-1", "attaching", "test")).toBe(true)
      expect(api.terminal.transitionLifecycle("pty-1", "attached", "test")).toBe(true)

      api.terminal.beginClosing("pty-1")
      expect(api.terminal.lifecycle("pty-1")).toBe("closing")

      api.terminal.clearClosing("pty-1")
      expect(api.terminal.lifecycle("pty-1")).toBe("closed")
    } finally {
      dispose()
    }
  })

  test("rejects illegal transition attached -> creating", () => {
    const { api, dispose } = createTestLayout()
    try {
      expect(api.terminal.transitionLifecycle("pty-2", "attached", "test")).toBe(true)
      expect(api.terminal.transitionLifecycle("pty-2", "creating", "test")).toBe(false)
      expect(api.terminal.lifecycle("pty-2")).toBe("attached")
    } finally {
      dispose()
    }
  })

  test("clearClosing does not force attached terminal to closed", () => {
    const { api, dispose } = createTestLayout()
    try {
      expect(api.terminal.transitionLifecycle("pty-3", "attached", "test")).toBe(true)
      api.terminal.clearClosing("pty-3")
      expect(api.terminal.lifecycle("pty-3")).toBe("attached")
    } finally {
      dispose()
    }
  })

  test("allows recovery transition closed -> attached", () => {
    const { api, dispose } = createTestLayout()
    try {
      expect(api.terminal.transitionLifecycle("pty-4", "closed", "test")).toBe(true)
      expect(api.terminal.transitionLifecycle("pty-4", "attached", "reconcile")).toBe(true)
      expect(api.terminal.lifecycle("pty-4")).toBe("attached")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// closeGroup identity stability
// ---------------------------------------------------------------------------

describe("closeGroup identity stability", () => {
  test("closeGroup preserves surviving group proxy identity for <For> tracking", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      tabs1.addSession("/ws", "s1", "Session 1")
      tabs2.addSession("/ws", "s2", "Session 2")

      // Capture the proxy reference for g1 before closeGroup
      const g1ProxyBefore = api.split.groups().find((g: any) => g.id === g1)

      // Close g2
      api.split.closeGroup(g2)

      // g1 should be the only remaining group
      expect(api.split.groups()).toHaveLength(1)
      expect(api.split.groups()[0].id).toBe(g1)

      // The surviving group proxy should keep identity so keyed rendering
      // treats it as the same group after merge.
      const g1ProxyAfter = api.split.groups().find((g: any) => g.id === g1)
      expect(g1ProxyAfter).toBe(g1ProxyBefore)
    } finally {
      dispose()
    }
  })

  test("closeGroup with terminal tabs preserves remaining group terminal state", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      // Add terminal tabs to both groups
      const termTab1 = tabs1.addTerminal("/ws", "pty-1", "Terminal 1")
      const termTab2 = tabs2.addTerminal("/ws", "pty-2", "Terminal 2")

      // Set up terminal state for both
      api.terminal.ensure(termTab1, "pty-1")
      api.terminal.ensure(termTab2, "pty-2")

      // Close g2
      api.split.closeGroup(g2)

      // g1's terminal tab should still exist and be active
      expect(api.split.groups()).toHaveLength(1)
      const remaining = api.groupTabs(g1)
      const termTabs = remaining.items().filter((t: any) => t.type === "terminal")
      expect(termTabs).toHaveLength(1)
      expect(termTabs[0].terminalId).toBe("pty-1")

      // g1's terminal state should be intact
      expect(api.terminal.ids(termTab1)).toContain("pty-1")

      // g2's terminal state should be cleared
      expect(api.terminal.ids(termTab2)).toEqual([])
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Compact mode safeguards (panelMode 5 ↔ review panel)
// ---------------------------------------------------------------------------

describe("terminal replaceId in layout", () => {
  test("replaceId updates pane tree, focus, and owner", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)

      tabs1.addTerminal("/ws", "pty-old", "Terminal")
      const tabId = tabs1.items()[0].id

      api.terminal.ensure(tabId, "pty-old")
      api.terminal.own(tabId, "pty-old")
      api.terminal.setFocus(tabId, "pty-old")

      api.terminal.replaceId(tabId, "pty-old", "pty-new")

      expect(api.terminal.ids(tabId)).toEqual(["pty-new"])
      expect(api.terminal.focus(tabId)).toBe("pty-new")
      expect(api.terminal.owner("pty-new")).toBe(tabId)
      expect(api.terminal.owner("pty-old")).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("replaceId in split pane only changes target leaf", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)

      tabs1.addTerminal("/ws", "pty-a", "Terminal")
      const tabId = tabs1.items()[0].id

      api.terminal.ensure(tabId, "pty-a")
      api.terminal.own(tabId, "pty-a")
      api.terminal.split({ tab: tabId, at: "pty-a", id: "pty-b", dir: "v" })
      api.terminal.own(tabId, "pty-b")

      api.terminal.replaceId(tabId, "pty-a", "pty-new")

      const ids = api.terminal.ids(tabId)
      expect(ids).toContain("pty-new")
      expect(ids).toContain("pty-b")
      expect(ids).not.toContain("pty-a")
    } finally {
      dispose()
    }
  })
})
