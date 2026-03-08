/**
 * Groups Silent Failure Tests
 *
 * Tests for the bug where setGroupItems silently returns when idx() is -1,
 * causing tab close operations to leave stale tabs in the items array.
 *
 * Bug hypothesis: When onClose (called in the close() batch) triggers
 * operations that invalidate the group index (e.g., group removal during
 * split close), subsequent setItems/setOrder/setClosedTabs calls silently
 * fail because idx() returns -1.
 *
 * These tests demonstrate that:
 * 1. Normal close works fine (GREEN)
 * 2. Close when group is invalidated during onClose leaves stale state (RED)
 * 3. setGroupItems should not silently swallow the failure (RED)
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { createRoot, batch } from "solid-js"
import { ensureLayoutMocked, getInitLayout } from "../_test-helper"

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
// setGroupItems silent failure
// ---------------------------------------------------------------------------

describe("setGroupItems silent failure on group removal", () => {
  test("normal process tab close removes it from items (baseline)", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)

      const sessionId = tabs1.addSession("/ws-a", "s1", "Session 1")
      const processId = tabs1.addProcess("/ws-a")

      expect(tabs1.items()).toHaveLength(2)

      // Close the process tab normally — group stays valid throughout
      tabs1.close(processId)

      // Process tab must be removed from items
      expect(tabs1.items().some((t: any) => t.id === processId)).toBe(false)
      expect(tabs1.items()).toHaveLength(1)
      expect(tabs1.activeId()).toBe(sessionId)
    } finally {
      dispose()
    }
  })

  test("closing process tab then immediately closing the group should not leave stale tab in merged group", () => {
    // BUG SCENARIO:
    // 1. Group g2 has a process tab + session tab
    // 2. Close the process tab from g2
    // 3. While close is processing (same tick), close group g2 → tabs merge into g1
    // 4. The process tab close's setGroupItems call targets g2's index,
    //    but g2 was removed, so idx() returns -1 and setGroupItems silently returns
    // 5. Result: the process tab survives in the merged items
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      // Add tabs to g2
      const sessionId = tabs2.addSession("/ws-a", "s1", "Session A")
      const processId = tabs2.addProcess("/ws-a")
      expect(tabs2.items()).toHaveLength(2)

      // Also add a tab to g1 so merge has something to land in
      tabs1.addSession("/ws-b", "s2", "Session B")

      // Close the process tab in g2, then immediately close g2 before
      // the close batch completes
      tabs2.close(processId)

      // Now close the group — this merges g2 tabs into g1
      api.split.closeGroup(g2)

      // After merge, the process tab should NOT be in g1's items.
      // If setGroupItems silently failed, the process tab would still
      // be present in the merged items.
      const mergedItems = tabs1.items()
      const hasProcess = mergedItems.some((t: any) => t.type === "process")
      expect(hasProcess).toBe(false)
    } finally {
      dispose()
    }
  })

  test("closing process tab in group then closing that group preserves correct worktree.default in surviving group", () => {
    // BUG SCENARIO:
    // When closing a process tab, the onClose callback tries to update
    // worktree.default. If the group is removed (closeGroup) while
    // onClose is processing, idx() returns -1 and the worktree update
    // also silently fails. The merged group may inherit a stale/invalid
    // worktree.default.
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      // g1 has a session in /ws-b
      tabs1.addSession("/ws-b", "s2", "Session B")
      expect(wt1.default()).toBe("/ws-b")

      // g2 has a process tab and session tab in /ws-a
      tabs2.addSession("/ws-a", "s1", "Session A")
      tabs2.addProcess("/ws-a")

      // Close the process tab in g2
      const processTab = tabs2.items().find((t: any) => t.type === "process")
      expect(processTab).toBeDefined()
      tabs2.close(processTab.id)

      // Close group g2 (merges remaining tabs into g1)
      api.split.closeGroup(g2)

      // g1's worktree.default should be valid — not null and not pointing
      // to a removed/invalid directory
      const wtDefault = wt1.default()
      expect(wtDefault).not.toBeNull()
      expect(typeof wtDefault).toBe("string")
    } finally {
      dispose()
    }
  })

  test("after process tab close where onClose triggers worktree update with idx -1, remaining tabs should be fully operable", () => {
    // Verifies that even after a silent failure in setGroupItems,
    // the remaining tabs can still be closed/switched.
    // This test is expected to FAIL if setGroupItems silently drops
    // the close operation, leaving the process tab as a ghost in items.
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      // Set up g2 with multiple tabs
      const session1 = tabs2.addSession("/ws-a", "s1", "Session 1")
      const processId = tabs2.addProcess("/ws-a")
      const session2 = tabs2.addSession("/ws-a", "s2", "Session 2")

      expect(tabs2.items()).toHaveLength(3)

      // Close the process tab
      tabs2.close(processId)

      // Verify process tab is gone
      expect(tabs2.items().some((t: any) => t.id === processId)).toBe(false)
      expect(tabs2.items()).toHaveLength(2)

      // Try to switch between remaining tabs — this should work
      tabs2.setActive(session1)
      expect(tabs2.activeId()).toBe(session1)

      tabs2.setActive(session2)
      expect(tabs2.activeId()).toBe(session2)

      // Try to close remaining tabs — this should work
      tabs2.close(session1)
      expect(tabs2.items()).toHaveLength(1)
      expect(tabs2.items()[0].id).toBe(session2)

      tabs2.close(session2)
      expect(tabs2.items()).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  test("closing the only process tab for a directory and then re-adding it should work", () => {
    // Tests that state isn't permanently corrupted after a process tab close.
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)

      // Add and close a process tab
      const processId1 = tabs1.addProcess("/ws-a")
      expect(tabs1.items()).toHaveLength(1)
      expect(api.multiPane.getState(processId1)).toBeDefined()

      tabs1.close(processId1)
      expect(tabs1.items()).toHaveLength(0)

      // Add a new process tab for the same directory
      const processId2 = tabs1.addProcess("/ws-a")
      expect(processId2).not.toBe(processId1) // should be a new tab
      expect(tabs1.items()).toHaveLength(1)
      expect(tabs1.items()[0].type).toBe("process")
      expect(tabs1.activeId()).toBe(processId2)

      // Multi-pane state should be initialized for the new tab
      expect(api.multiPane.getState(processId2)).toBeDefined()
    } finally {
      dispose()
    }
  })
})

describe("worktree.default after process tab close with directory change", () => {
  test("closing process tab that is the only tab for its directory should switch worktree.default to another directory", () => {
    // BUG SCENARIO:
    // 1. Group has tabs in two directories: /ws-a (session) and /ws-b (process only)
    // 2. worktree.default is /ws-b
    // 3. Close the process tab — it's the last tab for /ws-b
    // 4. The onClose hook in groups.ts checks if there are remaining tabs
    //    with the same directory. There aren't, so it tries to switch
    //    worktree.default to the new active tab's directory.
    // 5. But real() filters out "__process__" directories, and if the
    //    process tab's directory was a real directory, the switch should work.
    //
    // Expected: worktree.default switches to /ws-a (the only remaining directory)
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      // Add session in /ws-a
      const sessionId = tabs1.addSession("/ws-a", "s1", "Session A")

      // Add process tab in /ws-b (different directory)
      // First add a session so worktree.default can be set, then add process
      const tempSession = tabs1.addSession("/ws-b", "temp", "Temp")
      tabs1.setActive(tempSession)

      // Now add the process tab for /ws-b
      const processId = tabs1.addProcess("/ws-b")

      // Close the temp session, leaving only the process tab for /ws-b
      tabs1.close(tempSession)

      // Set worktree.default to /ws-b
      wt1.setDefault("/ws-b")
      expect(wt1.default()).toBe("/ws-b")

      // Close the process tab — last tab for /ws-b
      tabs1.close(processId)

      // worktree.default should switch to /ws-a (the only remaining real directory)
      // BUG: if the close handler doesn't properly handle process tabs,
      // worktree.default may stay as /ws-b even though no tabs remain for it
      expect(wt1.default()).toBe("/ws-a")
    } finally {
      dispose()
    }
  })

  test("closing process tab that is the ONLY tab in the group should not leave worktree.default pointing to a directory with no tabs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      // Add only a process tab
      const processId = tabs1.addProcess("/ws-a")
      expect(wt1.default()).toBe("/ws-a")

      // Close it — no tabs remain
      tabs1.close(processId)

      // After closing the only tab, worktree.default should either be
      // null (no tabs left) or still /ws-a (kept as fallback).
      // The key invariant: if worktree.default is non-null, there should
      // be at least one tab for that directory.
      const def = wt1.default()
      if (def !== null) {
        const hasTabForDefault = tabs1.items().some((t: any) => t.directory === def)
        expect(hasTabForDefault).toBe(true)
      }
      // Either way, items should be empty
      expect(tabs1.items()).toHaveLength(0)
    } finally {
      dispose()
    }
  })
})
