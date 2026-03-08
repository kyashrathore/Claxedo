/**
 * Process Tab Close Behavior Tests
 *
 * Reproduces the bug where closing a process tab causes the tab content to
 * vanish but the tab itself remains in the tab bar, preventing the user from
 * switching to other tabs or closing them.
 *
 * Uses the REAL layout facade (not mocks) via the same test setup pattern as
 * claxedo-layout.test.ts.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
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
// Process tab close behavior
// ---------------------------------------------------------------------------

describe("process tab close behavior", () => {
  test("close process tab removes it from items", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)

      const sessionId = tabs1.addSession("/ws-a", "s1", "Session 1")
      const processId = tabs1.addProcess("/ws-a")

      expect(tabs1.items()).toHaveLength(2)
      expect(tabs1.items().some((t: any) => t.type === "process")).toBe(true)
      expect(tabs1.items().some((t: any) => t.type === "session")).toBe(true)

      // Close the process tab
      tabs1.close(processId)

      // Process tab must be removed from items
      expect(tabs1.items().some((t: any) => t.id === processId)).toBe(false)
      // Session tab must still be present
      expect(tabs1.items().some((t: any) => t.id === sessionId)).toBe(true)
      expect(tabs1.items()).toHaveLength(1)
      // Active tab should fall back to the session tab
      expect(tabs1.activeId()).toBe(sessionId)
    } finally {
      dispose()
    }
  })

  test("after closing process tab, can still close other tabs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)

      const sessionId = tabs1.addSession("/ws-a", "s1", "Session 1")
      const processId = tabs1.addProcess("/ws-a")
      const terminalId = tabs1.addTerminal("/ws-a", "pty-1", "Terminal 1")

      expect(tabs1.items()).toHaveLength(3)

      // Close the process tab first
      tabs1.close(processId)
      expect(tabs1.items()).toHaveLength(2)
      expect(tabs1.items().some((t: any) => t.id === processId)).toBe(false)

      // Now close the session tab — this is what the user says doesn't work
      tabs1.close(sessionId)
      expect(tabs1.items()).toHaveLength(1)
      expect(tabs1.items().some((t: any) => t.id === sessionId)).toBe(false)

      // Only the terminal tab should remain
      const remaining = tabs1.items()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe(terminalId)
      expect(remaining[0].type).toBe("terminal")
      // Active tab should point to the terminal
      expect(tabs1.activeId()).toBe(terminalId)
    } finally {
      dispose()
    }
  })

  test("after closing process tab, can still switch active tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)

      const sessionA = tabs1.addSession("/ws-a", "s1", "Session A")
      const processId = tabs1.addProcess("/ws-a")
      const sessionB = tabs1.addSession("/ws-a", "s2", "Session B")

      expect(tabs1.items()).toHaveLength(3)

      // Close the process tab
      tabs1.close(processId)
      expect(tabs1.items()).toHaveLength(2)

      // Switch to session A
      tabs1.setActive(sessionA)
      expect(tabs1.activeId()).toBe(sessionA)

      // Switch to session B
      tabs1.setActive(sessionB)
      expect(tabs1.activeId()).toBe(sessionB)
    } finally {
      dispose()
    }
  })

  test("close process tab when it's the only tab leaves empty state", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)

      const processId = tabs1.addProcess("/ws-a")
      expect(tabs1.items()).toHaveLength(1)
      expect(tabs1.activeId()).toBe(processId)

      // Close the process tab
      tabs1.close(processId)

      // Items should be empty
      expect(tabs1.items()).toHaveLength(0)
      // Active ID should be null
      expect(tabs1.activeId()).toBeNull()
    } finally {
      dispose()
    }
  })

  test("close process tab clears multi-pane state but tab is removed from items", async () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)

      const processId = tabs1.addProcess("/ws-a")

      // Verify multi-pane state exists after adding process tab
      expect(api.multiPane.getState(processId)).toBeDefined()

      // Close the process tab
      tabs1.close(processId)

      // Tab must NOT be in items — this is the critical assertion:
      // the bug is that the tab stays in items after close
      expect(tabs1.items().some((t: any) => t.id === processId)).toBe(false)

      // Multi-pane state is cleared asynchronously via queueMicrotask
      // (it should still exist synchronously right after close)
      await new Promise<void>((resolve) => queueMicrotask(resolve))

      // After microtask, multi-pane state should be cleared
      expect(api.multiPane.getState(processId)).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("process tab close does not wedge tab operations when worktree default changes", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      const sessionId = tabs1.addSession("/ws-a", "s1", "Session A")
      const processId = tabs1.addProcess("/ws-a")

      // Worktree default should be /ws-a
      expect(wt1.default()).toBe("/ws-a")

      // Close the session tab so the process tab is the only /ws-a tab
      tabs1.close(sessionId)
      expect(tabs1.items()).toHaveLength(1)
      expect(tabs1.items()[0].id).toBe(processId)

      // Close the process tab — this triggers the worktree.default update
      // in the onClose hook because it's the last tab with /ws-a directory
      tabs1.close(processId)

      // Items should be empty
      expect(tabs1.items()).toHaveLength(0)
      // Worktree default should still be valid (either /ws-a since there's
      // no other directory to switch to, or null — both are acceptable).
      // The key assertion is that this doesn't throw or wedge state.
      const wtDefault = wt1.default()
      expect(wtDefault === "/ws-a" || wtDefault === null).toBe(true)
    } finally {
      dispose()
    }
  })

  test("closing process tab and then adding new tab works", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)

      const processId = tabs1.addProcess("/ws-a")
      expect(tabs1.items()).toHaveLength(1)

      // Close the process tab
      tabs1.close(processId)
      expect(tabs1.items()).toHaveLength(0)

      // Add a new session tab after closing the process tab
      const newSessionId = tabs1.addSession("/ws-b", "s1", "New Session")

      // Only the new session tab should be in items
      expect(tabs1.items()).toHaveLength(1)
      expect(tabs1.items()[0].id).toBe(newSessionId)
      expect(tabs1.items()[0].type).toBe("session")
      // Active tab should be the new session tab
      expect(tabs1.activeId()).toBe(newSessionId)
    } finally {
      dispose()
    }
  })

  test("closing process tab in quick succession with another close", async () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)

      const processId = tabs1.addProcess("/ws-a")
      const sessionId = tabs1.addSession("/ws-a", "s1", "Session 1")

      expect(tabs1.items()).toHaveLength(2)

      // Verify multi-pane state exists for the process tab
      expect(api.multiPane.getState(processId)).toBeDefined()

      // Close process tab and immediately close session tab
      // (before the microtask for multi-pane cleanup runs)
      tabs1.close(processId)
      tabs1.close(sessionId)

      // Both tabs should be gone from items
      expect(tabs1.items()).toHaveLength(0)
      expect(tabs1.items().some((t: any) => t.id === processId)).toBe(false)
      expect(tabs1.items().some((t: any) => t.id === sessionId)).toBe(false)

      // Wait for the deferred multi-pane cleanup microtask
      await new Promise<void>((resolve) => queueMicrotask(resolve))

      // Multi-pane state for the process tab should be cleaned up
      expect(api.multiPane.getState(processId)).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// worktree.default validity after process tab close
// ---------------------------------------------------------------------------

describe("worktree.default validity after process tab close", () => {
  test("closing the last tab of a directory should switch worktree.default to another directory", () => {
    // BUG HYPOTHESIS:
    // When closing the last tab for the current worktree.default directory,
    // the onClose hook in groups.ts tries to find a new directory from
    // remaining tabs. If the only remaining tab is a process tab with
    // directory "__process__", real() filters it out and worktree.default
    // may become stale (still pointing to the closed tab's directory).
    //
    // Expected: worktree.default switches to a valid directory with live tabs.
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      // Add tabs in two directories
      const sessionA = tabs1.addSession("/ws-a", "s1", "Session A")
      const sessionB = tabs1.addSession("/ws-b", "s2", "Session B")

      // Set default to /ws-a
      wt1.setDefault("/ws-a")
      expect(wt1.default()).toBe("/ws-a")

      // Close the only /ws-a tab
      tabs1.close(sessionA)

      // worktree.default should switch to /ws-b (the only remaining directory)
      // since there are no more tabs in /ws-a
      const def = wt1.default()
      expect(def).toBe("/ws-b")
    } finally {
      dispose()
    }
  })

  test("closing a process tab that is the only tab for its directory should update worktree.default", () => {
    // BUG: process tab uses a real directory (e.g., "/ws-a"), but when the
    // onClose callback runs, it checks remainingItems for tabs with the same
    // directory. If no remaining tabs use that directory, it should switch
    // worktree.default. But the process tab's directory might be skipped
    // by real() if the close hook doesn't properly track the directory change.
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      // Add a session in /ws-b so there's a fallback directory
      const sessionB = tabs1.addSession("/ws-b", "s2", "Session B")

      // Add a process tab in /ws-a
      const processId = tabs1.addProcess("/ws-a")

      // Set default to /ws-a (the process tab's directory)
      wt1.setDefault("/ws-a")
      expect(wt1.default()).toBe("/ws-a")

      // Close the process tab — it's the only tab for /ws-a
      tabs1.close(processId)

      // worktree.default should now point to /ws-b, not stay as /ws-a
      // BUG: if the onClose handler doesn't account for the process tab's
      // real directory, worktree.default remains /ws-a even though no tabs
      // use that directory anymore.
      const def = wt1.default()
      expect(def).toBe("/ws-b")
    } finally {
      dispose()
    }
  })

  test("after closing process tab, worktree.default should never point to a directory with no remaining tabs", () => {
    // Invariant check: if worktree.default is non-null, at least one tab
    // in items should have that directory.
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      // Create a process tab + session tab in /ws-a
      const sessionId = tabs1.addSession("/ws-a", "s1", "Session A")
      const processId = tabs1.addProcess("/ws-a")
      expect(wt1.default()).toBe("/ws-a")

      // Close the session first, leaving only the process tab for /ws-a
      tabs1.close(sessionId)

      // Process tab is the only tab for /ws-a
      expect(tabs1.items()).toHaveLength(1)
      expect(tabs1.items()[0].id).toBe(processId)
      expect(tabs1.items()[0].directory).toBe("/ws-a")

      // Close the process tab — last tab for /ws-a
      tabs1.close(processId)
      expect(tabs1.items()).toHaveLength(0)

      // INVARIANT: if worktree.default is non-null, there must be tabs for it
      const def = wt1.default()
      if (def !== null) {
        const hasTabsForDefault = tabs1.items().some((t: any) => t.directory === def)
        // BUG: if worktree.default is still "/ws-a" but no tabs remain,
        // this invariant is violated.
        expect(hasTabsForDefault).toBe(true)
      }
    } finally {
      dispose()
    }
  })

  test("closing process tab with multi-directory tabs preserves correct worktree.default", () => {
    // Setup: tabs in /ws-a and /ws-b, process tab in /ws-a, default is /ws-a.
    // Close the process tab. Session tab for /ws-a still exists.
    // worktree.default should stay /ws-a (there's still a session tab there).
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      const sessionA = tabs1.addSession("/ws-a", "s1", "Session A")
      const processA = tabs1.addProcess("/ws-a")
      const sessionB = tabs1.addSession("/ws-b", "s2", "Session B")

      expect(wt1.default()).toBe("/ws-a")
      expect(tabs1.items()).toHaveLength(3)

      // Close the process tab
      tabs1.close(processA)

      // worktree.default should still be /ws-a because session A is still there
      expect(wt1.default()).toBe("/ws-a")
      expect(tabs1.items()).toHaveLength(2)
    } finally {
      dispose()
    }
  })
})
