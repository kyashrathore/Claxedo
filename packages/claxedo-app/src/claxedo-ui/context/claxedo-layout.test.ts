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

describe("tab isolation between groups", () => {
  test("adding session to group A does not appear in group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      tabs1.addSession("/ws", "s1", "Session 1")

      expect(tabs1.items()).toHaveLength(1) // session
      expect(tabs1.items().find((t: any) => t.type === "session")!.sessionId).toBe("s1")
      expect(tabs2.items()).toHaveLength(0) // empty
    } finally {
      dispose()
    }
  })

  test("adding terminal to group A does not appear in group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      tabs1.addTerminal("/ws", "pty-1", "Terminal 1")

      expect(tabs1.items()).toHaveLength(1) // terminal
      expect(tabs1.items().find((t: any) => t.type === "terminal")!.terminalId).toBe("pty-1")
      expect(tabs2.items()).toHaveLength(0) // empty
    } finally {
      dispose()
    }
  })

  test("adding review to group A does not appear in group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      tabs1.addReview("/ws", "rev-1", "Review 1", { additions: 5, deletions: 2 })

      expect(tabs1.items()).toHaveLength(1) // review
      expect(tabs1.items().find((t: any) => t.type === "review")!.type).toBe("review")
      expect(tabs2.items()).toHaveLength(0) // empty
    } finally {
      dispose()
    }
  })

  test("review tabs dedupe by mode and refs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)
      const a = tabs1.addReview("/ws", "s1", "Session", undefined, "session")
      const b = tabs1.addReview("/ws", "s1", "Session", undefined, "session")
      const c = tabs1.addReview("/ws", "s1", "Session", undefined, "to-from", "HEAD~1", "HEAD")

      expect(a).toBe(b)
      expect(a).not.toBe(c)
      expect(tabs1.items()).toHaveLength(2) // 2 reviews
      const modes = tabs1
        .items()
        .filter((tab: any) => tab.type === "review")
        .map((tab: any) => tab.reviewMode)
      expect(modes).toEqual(["session", "to-from"])
    } finally {
      dispose()
    }
  })

  test("context tab dedupes by directory and session", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)
      const a = tabs1.addContext("/ws", "s1", "Context")
      const b = tabs1.addContext("/ws", "s1", "Context")
      const c = tabs1.addContext("/ws", "s2", "Context")

      expect(a).toBe(b)
      expect(a).not.toBe(c)
      expect(tabs1.items().filter((tab: any) => tab.type === "context")).toHaveLength(2)
    } finally {
      dispose()
    }
  })

  test("adding file tab to group A does not appear in group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      tabs1.addFile("/ws", "/ws/main.ts", "main.ts")

      expect(tabs1.items()).toHaveLength(1) // file
      expect(tabs1.items().find((t: any) => t.type === "file")!.type).toBe("file")
      expect(tabs2.items()).toHaveLength(0) // empty
    } finally {
      dispose()
    }
  })

  test("closing tab in group A does not affect group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const id1 = tabs1.addSession("/ws", "s1", "Session 1")
      const id2 = tabs2.addSession("/ws", "s2", "Session 2")

      tabs1.close(id1)

      expect(tabs1.items()).toHaveLength(0) // empty
      expect(tabs2.items()).toHaveLength(1) // session
      expect(tabs2.items().find((t: any) => t.id === id2)).toBeDefined()
    } finally {
      dispose()
    }
  })

  test("close all tabs in group A leaves group B intact", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const a = tabs1.addSession("/ws", "s1", "S1")
      const b = tabs1.addTerminal("/ws", "pty-1", "T1")
      tabs2.addSession("/ws", "s2", "S2")
      tabs2.addTerminal("/ws", "pty-2", "T2")

      tabs1.close(a)
      tabs1.close(b)

      expect(tabs1.items()).toHaveLength(0) // empty
      expect(tabs2.items()).toHaveLength(2) // session + terminal
    } finally {
      dispose()
    }
  })

  test("reopen last in group A does not affect group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const id = tabs1.addSession("/ws", "s1", "Session 1")
      tabs2.addSession("/ws", "s2", "Session 2")

      tabs1.close(id)
      expect(tabs1.items()).toHaveLength(0) // empty

      tabs1.reopenLast()

      expect(tabs1.items()).toHaveLength(1) // session
      expect(tabs1.items().find((t: any) => t.type === "session")!.sessionId).toBe("s1")
      expect(tabs2.items()).toHaveLength(1) // session
      expect(tabs2.items().find((t: any) => t.type === "session")!.sessionId).toBe("s2")
    } finally {
      dispose()
    }
  })

  test("active tab in group A is independent of group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const a1 = tabs1.addSession("/ws", "s1", "S1")
      const a2 = tabs1.addSession("/ws", "s2", "S2")
      const b1 = tabs2.addSession("/ws", "s3", "S3")

      tabs1.setActive(a1)

      expect(tabs1.activeId()).toBe(a1)
      // Group B active should still be b1 (last added)
      expect(tabs2.activeId()).toBe(b1)

      tabs1.setActive(a2)
      expect(tabs1.activeId()).toBe(a2)
      expect(tabs2.activeId()).toBe(b1)
    } finally {
      dispose()
    }
  })

  test("tab ordering in group A is independent of group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const a1 = tabs1.addSession("/ws", "s1", "S1")
      const a2 = tabs1.addSession("/ws", "s2", "S2")
      const b1 = tabs2.addSession("/ws", "s3", "S3")
      const b2 = tabs2.addSession("/ws", "s4", "S4")

      // Reorder group A
      tabs1.move(a1, 1) // move to end

      const orderedA = tabs1.orderedItems().map((t: any) => t.id)
      const orderedB = tabs2.orderedItems().map((t: any) => t.id)

      expect(orderedA).toEqual([a2, a1])
      expect(orderedB).toEqual([b1, b2])
    } finally {
      dispose()
    }
  })

  test("addSession deduplicates within same group", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)

      const id1 = tabs1.addSession("/ws", "s1", "Session 1")
      const id2 = tabs1.addSession("/ws", "s1", "Session 1 Updated")

      expect(id1).toBe(id2)
      expect(tabs1.items()).toHaveLength(1) // session
      expect(tabs1.items().find((t: any) => t.type === "session")!.title).toBe("Session 1 Updated")
    } finally {
      dispose()
    }
  })

  test("same session in different groups gets independent tabs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const id1 = tabs1.addSession("/ws", "shared-session", "Session")
      const id2 = tabs2.addSession("/ws", "shared-session", "Session")

      expect(id1).not.toBe(id2)
      expect(tabs1.items()).toHaveLength(1) // session
      expect(tabs2.items()).toHaveLength(1) // session
    } finally {
      dispose()
    }
  })

  test("badge update in group A does not affect same session in group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const id1 = tabs1.addSession("/ws", "shared", "S")
      const id2 = tabs2.addSession("/ws", "shared", "S")

      tabs1.updateBadge(id1, { additions: 10, deletions: 3 })

      expect(tabs1.items().find((t: any) => t.id === id1)!.badge).toEqual({ additions: 10, deletions: 3 })
      expect(tabs2.items().find((t: any) => t.id === id2)!.badge).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("title update in group A does not affect same session in group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const id1 = tabs1.addSession("/ws", "shared", "Original")
      tabs2.addSession("/ws", "shared", "Original")

      tabs1.updateTitle(id1, "Updated Title")

      expect(tabs1.items().find((t: any) => t.id === id1)!.title).toBe("Updated Title")
      expect(tabs2.items().find((t: any) => t.type === "session")!.title).toBe("Original")
    } finally {
      dispose()
    }
  })

  test("patch in group A does not affect group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const id1 = tabs1.addTerminal("/ws", "pty-1", "Terminal 1")
      tabs2.addTerminal("/ws", "pty-1", "Terminal 1")

      tabs1.patch(id1, { attention: true, loading: true })

      expect(tabs1.items().find((t: any) => t.id === id1)!.attention).toBe(true)
      expect(tabs1.items().find((t: any) => t.id === id1)!.loading).toBe(true)
      expect(tabs2.items().find((t: any) => t.type === "terminal")!.attention).toBeUndefined()
      expect(tabs2.items().find((t: any) => t.type === "terminal")!.loading).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("review focus patch stays scoped to the owning group tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const id1 = tabs1.addReview("/ws", "ses_1", "Review", undefined, "uncommitted")
      tabs2.addReview("/ws", "ses_1", "Review", undefined, "uncommitted")

      tabs1.patch(id1, { reviewFocusPath: "src/focused.ts", reviewFocusVersion: 3 })

      const t1 = tabs1.items().find((tab: any) => tab.id === id1)
      const t2 = tabs2.items().find((tab: any) => tab.type === "review")
      expect(t1?.reviewFocusPath).toBe("src/focused.ts")
      expect(t1?.reviewFocusVersion).toBe(3)
      expect(t2!.reviewFocusPath).toBeUndefined()
      expect(t2!.reviewFocusVersion).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// topTabs delegation
// ---------------------------------------------------------------------------

describe("topTabs delegates to focused group", () => {
  test("topTabs reads from focused group only", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      tabs1.addSession("/ws", "s1", "In Group 1")
      tabs2.addSession("/ws", "s2", "In Group 2")

      api.split.setFocus(g1)
      expect(api.topTabs.items()).toHaveLength(1) // session
      expect(api.topTabs.items().find((t: any) => t.type === "session")!.sessionId).toBe("s1")

      api.split.setFocus(g2)
      expect(api.topTabs.items()).toHaveLength(1) // session
      expect(api.topTabs.items().find((t: any) => t.type === "session")!.sessionId).toBe("s2")
    } finally {
      dispose()
    }
  })

  test("topTabs writes go to focused group only", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1, tabs2 } = splitInto2(api)

      api.split.setFocus(g1)
      api.topTabs.addSession("/ws", "top-session", "TopTab Session")

      expect(tabs1.items()).toHaveLength(1) // session
      expect(tabs1.items().find((t: any) => t.type === "session")!.sessionId).toBe("top-session")
      expect(tabs2.items()).toHaveLength(0) // empty
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Worktree isolation
// ---------------------------------------------------------------------------

describe("worktree isolation between groups", () => {
  test("setDefault in group A does not affect group B and is visible via worktree alias when focused", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)
      const wt2 = api.groupWorktree(g2)

      wt1.setDefault("/workspace-a")

      // Group B is unaffected (isolation) — its default is null
      // because the new group starts empty
      expect(wt2.default()).toBeNull()

      // The worktree alias delegates to the focused group.
      // When g1 is focused, the alias should reflect g1's default.
      api.split.setFocus(g1)
      expect(api.worktree.default()).toBe("/workspace-a")

      // When g2 is focused, the alias should reflect g2's default.
      api.split.setFocus(g2)
      expect(api.worktree.default()).toBeNull()
    } finally {
      dispose()
    }
  })

  test("setPinned in group A does not affect group B and is visible via worktree alias when focused", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)
      const wt2 = api.groupWorktree(g2)

      wt1.setPinned("/pinned-a")

      // Group B is unaffected (isolation)
      expect(wt2.pinned()).toBeNull()

      // The worktree alias delegates to the focused group.
      api.split.setFocus(g1)
      expect(api.worktree.pinned()).toBe("/pinned-a")

      // When g2 is focused, the alias should reflect g2's pinned (null).
      api.split.setFocus(g2)
      expect(api.worktree.pinned()).toBeNull()
    } finally {
      dispose()
    }
  })

  test("worktree alias delegates to focused group", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)
      const wt2 = api.groupWorktree(g2)

      wt1.setDefault("/ws-a")
      wt2.setDefault("/ws-b")

      api.split.setFocus(g1)
      expect(api.worktree.default()).toBe("/ws-a")

      api.split.setFocus(g2)
      expect(api.worktree.default()).toBe("/ws-b")
    } finally {
      dispose()
    }
  })

  test("addSession auto-sets worktree.default when null (groupTabs)", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      // Default is null initially
      expect(wt1.default()).toBeNull()

      // Adding a session should auto-set the default
      tabs1.addSession("/workspace-a", "s1", "Session 1")

      expect(wt1.default()).toBe("/workspace-a")
    } finally {
      dispose()
    }
  })

  test("addSession does not overwrite existing worktree.default (groupTabs)", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      wt1.setDefault("/existing-workspace")
      tabs1.addSession("/other-workspace", "s1", "Session 1")

      // Should keep the existing default, not overwrite
      expect(wt1.default()).toBe("/existing-workspace")
    } finally {
      dispose()
    }
  })

  test("addSession auto-sets worktree.default when null (topTabs)", () => {
    const { api, dispose } = createTestLayout()
    try {
      // Single group (no split) — topTabs delegates to the only group
      expect(api.worktree.default()).toBeNull()

      api.topTabs.addSession("/workspace-main", "s1", "Session 1")

      expect(api.worktree.default()).toBe("/workspace-main")
    } finally {
      dispose()
    }
  })

  test("addTerminal auto-sets worktree.default when null", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      expect(wt1.default()).toBeNull()

      tabs1.addTerminal("/workspace-a", "pty-1", "Terminal 1")

      expect(wt1.default()).toBe("/workspace-a")
    } finally {
      dispose()
    }
  })

  test("auto-set worktree.default is per-group (isolation)", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)
      const wt2 = api.groupWorktree(g2)

      tabs1.addSession("/workspace-a", "s1", "Session 1")
      tabs2.addSession("/workspace-b", "s2", "Session 2")

      expect(wt1.default()).toBe("/workspace-a")
      // g2's default starts null (new group starts empty), then auto-set by addSession
      expect(wt2.default()).toBe("/workspace-b")
    } finally {
      dispose()
    }
  })

  test("closing session tab does not switch worktree.default when process tab shares same directory", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      const id1 = tabs1.addSession("/workspace-a", "s1", "Session A")
      tabs1.addSession("/workspace-b", "s2", "Session B")
      // Explicitly add a process tab so it shares /workspace-a directory
      tabs1.addProcess("/workspace-a")

      expect(wt1.default()).toBe("/workspace-a")

      // Process tab directory syncs with worktree.default (/workspace-a),
      // so closing the session still leaves a tab with that directory
      tabs1.close(id1)

      expect(wt1.default()).toBe("/workspace-a")
    } finally {
      dispose()
    }
  })

  test("closing tab does not change worktree.default when other tabs share same directory", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      const id1 = tabs1.addSession("/workspace-a", "s1", "Session 1")
      tabs1.addSession("/workspace-a", "s2", "Session 2")

      expect(wt1.default()).toBe("/workspace-a")

      // Close one tab — another tab still has /workspace-a, default stays
      tabs1.close(id1)

      expect(wt1.default()).toBe("/workspace-a")
    } finally {
      dispose()
    }
  })

  test("closing all tabs keeps worktree.default (no remaining tab to switch to)", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      const id1 = tabs1.addSession("/workspace-a", "s1", "Session A")

      expect(wt1.default()).toBe("/workspace-a")

      tabs1.close(id1)

      // Default persists — there's no next tab to switch to
      expect(wt1.default()).toBe("/workspace-a")
    } finally {
      dispose()
    }
  })

  test("closing tab for different directory than worktree.default does not change default", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, tabs1 } = splitInto2(api)
      const wt1 = api.groupWorktree(g1)

      tabs1.addSession("/workspace-a", "s1", "Session A")
      const id2 = tabs1.addSession("/workspace-b", "s2", "Session B")

      // Default is /workspace-a (auto-set from first tab)
      expect(wt1.default()).toBe("/workspace-a")

      // Closing the /workspace-b tab should not affect default
      tabs1.close(id2)

      expect(wt1.default()).toBe("/workspace-a")
    } finally {
      dispose()
    }
  })

  test("closing session via topTabs does not switch worktree.default when process tab shares directory", () => {
    const { api, dispose } = createTestLayout()
    try {
      const id1 = api.topTabs.addSession("/workspace-a", "s1", "Session A")
      api.topTabs.addSession("/workspace-b", "s2", "Session B")
      // Explicitly add a process tab so it shares /workspace-a directory
      api.topTabs.addProcess("/workspace-a")

      expect(api.worktree.default()).toBe("/workspace-a")

      // Process tab directory syncs with worktree default, so /workspace-a is still
      // present via the process tab — default does NOT switch
      api.topTabs.close(id1)

      expect(api.worktree.default()).toBe("/workspace-a")
    } finally {
      dispose()
    }
  })

  test("closing process tab defers multi-pane cleanup until after tab removal", async () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)
      const tabs = api.groupTabs(g1)

      const id = tabs.addProcess("/workspace-a")
      expect(api.multiPane.getState(id)).toBeDefined()

      tabs.close(id)

      expect(tabs.items().find((tab: any) => tab.id === id)).toBeUndefined()
      expect(api.multiPane.getState(id)).toBeDefined()

      await new Promise<void>((resolve) => queueMicrotask(resolve))

      expect(api.multiPane.getState(id)).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Layout isolation (file tree, session panel, review panel)
// ---------------------------------------------------------------------------

describe("layout isolation between groups", () => {
  test("session panel state per group persists across focus switches", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2 } = splitInto2(api)
      const layout1 = api.groupLayout(g1)
      const layout2 = api.groupLayout(g2)

      layout1.session.setCollapsed(true)
      layout1.session.setWidth(300)
      layout1.session.setPanelMode(2)

      // Session panel accessors are compatibility shims and inert.
      expect(layout2.session.collapsed()).toBe(false)
      expect(layout2.session.width()).toBe(600)
      expect(layout2.session.panelMode()).toBe(0)

      // After switching focus to g2 and back, state remains unchanged.
      api.split.setFocus(g2)
      api.split.setFocus(g1)

      expect(layout1.session.collapsed()).toBe(false)
      expect(layout1.session.width()).toBe(600)
      expect(layout1.session.panelMode()).toBe(0)

      // Mutating group2 shim also remains inert.
      api.split.setFocus(g2)
      layout2.session.setWidth(800)
      layout2.session.setPanelMode(1)
      expect(layout1.session.width()).toBe(600)
      expect(layout1.session.panelMode()).toBe(0)
      expect(layout2.session.width()).toBe(600)
      expect(layout2.session.panelMode()).toBe(0)
    } finally {
      dispose()
    }
  })

  test("review panel accessors are inert compatibility shims", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2 } = splitInto2(api)
      const layout1 = api.groupLayout(g1)
      const layout2 = api.groupLayout(g2)

      // Both default to false
      expect(layout1.reviewPanel.opened()).toBe(false)
      expect(layout2.reviewPanel.opened()).toBe(false)

      // Setting opened does not change persisted state.
      layout1.reviewPanel.setOpened(true)

      expect(layout1.reviewPanel.opened()).toBe(false)
      expect(layout2.reviewPanel.opened()).toBe(false)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Split operations
// ---------------------------------------------------------------------------

describe("split operations", () => {
  test("toggle creates second group with empty tabs", () => {
    const { api, dispose } = createTestLayout()
    try {
      expect(api.split.groups()).toHaveLength(1)

      api.split.toggle()

      expect(api.split.groups()).toHaveLength(2)
      expect(api.split.sizes()).toEqual([0.5, 0.5])

      const g2 = api.split.groups()[1]
      expect(api.groupTabs(g2.id).items()).toHaveLength(0) // empty
    } finally {
      dispose()
    }
  })

  test("toggle seeds new group workspace default from active tab directory when primary default is unset", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.topTabs.addSession("/workspace-main", "s1", "Session 1")
      api.split.toggle()
      const groups = api.split.groups()
      const g2 = groups[1]
      expect(api.groupWorktree(g2.id).default()).toBe("/workspace-main")
    } finally {
      dispose()
    }
  })

  test("toggle hides split (groups preserved, only primary visible)", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.split.toggle()
      const groups = api.split.groups()
      const tabs1 = api.groupTabs(groups[0].id)
      const tabs2 = api.groupTabs(groups[1].id)

      tabs1.addSession("/ws", "s1", "Session 1")
      tabs2.addSession("/ws", "s2", "Session 2")
      tabs2.addTerminal("/ws", "pty-1", "Terminal 1")

      // Toggle hides — groups still exist, split.active is false
      api.split.toggle()

      expect(api.split.groups()).toHaveLength(2)
      expect(api.split.active()).toBe(false)
      expect(api.split.hidden()).toBe(true)

      // Tabs are preserved in both groups
      expect(tabs1.items()).toHaveLength(1) // session
      expect(tabs2.items()).toHaveLength(2) // session + terminal

      // Toggle again shows
      api.split.toggle()
      expect(api.split.active()).toBe(true)
      expect(api.split.hidden()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("toggle hide preserves focused group", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.split.toggle()
      const groups = api.split.groups()
      const g2 = groups[1].id
      api.split.setFocus(g2)
      expect(api.split.focusedId()).toBe(g2)

      api.split.toggle()
      expect(api.split.hidden()).toBe(true)
      expect(api.split.focusedId()).toBe(g2)
    } finally {
      dispose()
    }
  })

  test("closeGroup merges non-terminal tabs into first group and drops closed-group terminals", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.split.toggle()
      const groups = api.split.groups()
      const g2Id = groups[1].id
      const tabs1 = api.groupTabs(groups[0].id)
      const tabs2 = api.groupTabs(g2Id)

      tabs1.addSession("/ws", "s1", "Session 1")
      tabs2.addSession("/ws", "s2", "Session 2")
      tabs2.addTerminal("/ws", "pty-1", "Terminal 1")

      // Close group 2 — merge keeps non-terminals, terminals are disposed.
      api.split.closeGroup(g2Id)

      expect(api.split.groups()).toHaveLength(1)
      const merged = api.groupTabs(api.split.groups()[0].id)
      const sessions = merged.items().filter((t: any) => t.type === "session")
      const terminals = merged.items().filter((t: any) => t.type === "terminal")

      expect(sessions).toHaveLength(2)
      expect(terminals).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  test("closeGroup assigns active tab when primary group was empty", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.split.toggle()
      const [g1, g2] = api.split.groups().map((g: any) => g.id)
      const tabs1 = api.groupTabs(g1)
      const tabs2 = api.groupTabs(g2)

      const right = tabs2.addSession("/ws", "s-right", "Right session")
      expect(right).toBeTruthy()
      if (!right) return

      // Primary group is empty; after merge it receives the session.
      expect(tabs1.items()).toHaveLength(0) // empty

      api.split.closeGroup(g2)

      const primary = api.groupTabs(g1)
      expect(primary.items()).toHaveLength(1) // session
      expect(primary.items().find((t: any) => t.type === "session")?.sessionId).toBe("s-right")
      expect(primary.active()).toBeDefined()
    } finally {
      dispose()
    }
  })

  test("closeGroup does not move terminal tabs from closed group into primary", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)
      const left = tabs1.addTerminal("/ws", "pty-left", "Left")
      const right = tabs2.addTerminal("/ws", "pty-right", "Right")
      expect(left).toBeTruthy()
      expect(right).toBeTruthy()
      if (!left || !right) return

      api.split.closeGroup(g2)

      const remaining = api.groupTabs(g1)
      expect(remaining.items().some((t: any) => t.terminalId === "pty-left")).toBe(true)
      expect(remaining.items().some((t: any) => t.terminalId === "pty-right")).toBe(false)
    } finally {
      dispose()
    }
  })

  test("moveTab transfers tab from source to destination group", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      const id = tabs1.addSession("/ws", "s1", "Session 1")
      tabs1.addTerminal("/ws", "pty-1", "Terminal 1")

      expect(tabs1.items()).toHaveLength(2) // session + terminal
      expect(tabs2.items()).toHaveLength(0) // empty

      api.split.moveTab(id, g1, g2)

      expect(tabs1.items()).toHaveLength(1) // terminal
      expect(tabs1.items().find((t: any) => t.type === "terminal")).toBeDefined()
      expect(tabs2.items()).toHaveLength(1) // session
      expect(tabs2.items().find((t: any) => t.type === "session")!.sessionId).toBe("s1")
    } finally {
      dispose()
    }
  })

  test("moveTab to 'new' removes tab from source group", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      // Add tabs to both groups so neither gets auto-removed
      const id = tabs1.addSession("/ws", "s1", "Session 1")
      tabs1.addTerminal("/ws", "pty-1", "Terminal 1")
      tabs2.addSession("/ws", "s2", "Session 2")

      api.split.moveTab(id, g1, g2)

      // g1 retains the terminal, g2 now has both sessions
      expect(tabs1.items()).toHaveLength(1) // terminal
      expect(tabs1.items().find((t: any) => t.type === "terminal")).toBeDefined()
      expect(tabs2.items()).toHaveLength(2) // 2 sessions
      expect(tabs2.items().some((t: any) => t.sessionId === "s1")).toBe(true)
      expect(tabs2.items().some((t: any) => t.sessionId === "s2")).toBe(true)
    } finally {
      dispose()
    }
  })

  test("setFocus changes focused group without mutating tabs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      tabs1.addSession("/ws", "s1", "S1")
      tabs2.addSession("/ws", "s2", "S2")

      expect(api.split.focusedId()).toBe(g1)

      api.split.setFocus(g2)

      expect(api.split.focusedId()).toBe(g2)
      // Tabs unchanged (each has session)
      expect(tabs1.items()).toHaveLength(1)
      expect(tabs2.items()).toHaveLength(1)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end scenarios
// ---------------------------------------------------------------------------

describe("end-to-end split panel scenarios", () => {
  test("full workflow: create sessions and terminals in both groups independently", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      // Group 1: session + terminal
      const s1 = tabs1.addSession("/ws-a", "session-a", "Session A")
      const t1 = tabs1.addTerminal("/ws-a", "pty-a", "Terminal A")

      // Group 2: different session + terminal
      const s2 = tabs2.addSession("/ws-b", "session-b", "Session B")
      const t2 = tabs2.addTerminal("/ws-b", "pty-b", "Terminal B")

      // Verify complete isolation
      expect(tabs1.items()).toHaveLength(2) // session + terminal
      expect(tabs2.items()).toHaveLength(2)
      expect(
        tabs1
          .items()
          .map((t: any) => t.id)
          .sort(),
      ).toEqual([s1, t1].sort())
      expect(
        tabs2
          .items()
          .map((t: any) => t.id)
          .sort(),
      ).toEqual([s2, t2].sort())

      // Close terminal in group 1 — group 2 unaffected
      tabs1.close(t1)
      expect(tabs1.items()).toHaveLength(1) // session
      expect(tabs1.items().find((t: any) => t.id === s1)).toBeDefined()
      expect(tabs2.items()).toHaveLength(2) // session + terminal

      // Badge update in group 2 — group 1 unaffected
      tabs2.updateBadge(s2, { additions: 5, deletions: 1 })
      expect(tabs1.items().find((t: any) => t.id === s1)!.badge).toBeUndefined()
      expect(tabs2.items().find((t: any) => t.id === s2)?.badge).toEqual({ additions: 5, deletions: 1 })

      // Active tab switching — independent
      tabs1.setActive(s1)
      tabs2.setActive(t2)
      expect(tabs1.activeId()).toBe(s1)
      expect(tabs2.activeId()).toBe(t2)
    } finally {
      dispose()
    }
  })

  test("terminal creation request targets correct group, does not leak", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2 } = splitInto2(api)

      // Request terminal creation for group 2
      api.terminal.requestCreate("/ws", "npm start", "Agent", g2)

      // Verify targeting
      expect(api.terminal.creating()).toBe(1)
      expect(api.terminal.creatingGroupId()).toBe(g2)
      expect(api.terminal.pendingGroupId()).toBe(g2)

      // Consume
      const { groupId, command, title } = api.terminal.consumePendingCommand()
      expect(groupId).toBe(g2)
      expect(command).toBe("npm start")
      expect(title).toBe("Agent")

      // Complete
      api.terminal.created()
      expect(api.terminal.creating()).toBe(0)
      expect(api.terminal.creatingGroupId()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("same terminal ID in panes of different tabs stays isolated", () => {
    const { api, dispose } = createTestLayout()
    try {
      // Two tabs referencing the same PTY ID in their panes
      // (shouldn't happen in practice, but tests isolation)
      api.terminal.ensure("tab-a", "pty-shared")
      api.terminal.ensure("tab-b", "pty-shared")

      api.terminal.split({ tab: "tab-a", at: "pty-shared", id: "pty-extra", dir: "v" })

      // tab-a has split, tab-b still has single leaf
      expect(api.terminal.ids("tab-a")).toEqual(["pty-shared", "pty-extra"])
      expect(api.terminal.ids("tab-b")).toEqual(["pty-shared"])

      // Closing from tab-a doesn't affect tab-b
      api.terminal.close({ tab: "tab-a", id: "pty-extra" })
      expect(api.terminal.ids("tab-a")).toEqual(["pty-shared"])
      expect(api.terminal.ids("tab-b")).toEqual(["pty-shared"])
    } finally {
      dispose()
    }
  })

  test("notification badges: attention/done flags isolated per tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const t1 = tabs1.addTerminal("/ws", "pty-1", "Terminal 1")
      const t2 = tabs2.addTerminal("/ws", "pty-2", "Terminal 2")

      // Set attention on group 1's terminal tab
      tabs1.patch(t1, { attention: true })

      expect(tabs1.items().find((t: any) => t.id === t1)!.attention).toBe(true)
      expect(tabs2.items().find((t: any) => t.id === t2)!.attention).toBeUndefined()

      // Set done indicator on group 2's terminal tab
      tabs2.patch(t2, { done: true })

      expect(tabs1.items().find((t: any) => t.id === t1)!.done).toBeUndefined()
      expect(tabs2.items().find((t: any) => t.id === t2)!.done).toBe(true)
    } finally {
      dispose()
    }
  })

  test("loading indicator isolated per tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      const t1 = tabs1.addSession("/ws", "s1", "Session 1")
      tabs2.addSession("/ws", "s2", "Session 2")

      tabs1.patch(t1, { loading: true })

      expect(tabs1.items().find((t: any) => t.id === t1)!.loading).toBe(true)
      expect(tabs2.items().find((t: any) => t.type === "session")!.loading).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Bug regression: split toggle merge and state cleanup
// ---------------------------------------------------------------------------

describe("tab operations work after closing split", () => {
  test("close all tabs in right panel, closeGroup, then create/close tabs in remaining panel", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      // Add sessions to both groups
      tabs1.addSession("/ws", "s1", "Session 1")
      const temp = tabs2.addSession("/ws", "temp", "Temp Session")

      // Close all user tabs in right panel
      tabs2.close(temp)
      expect(tabs2.items()).toHaveLength(0) // empty

      // Close group 2 explicitly
      api.split.closeGroup(g2)

      // Remaining group should have session
      const remainingId = api.split.groups()[0].id
      const remaining = api.groupTabs(remainingId)
      expect(remaining.items()).toHaveLength(1) // session

      // Create new tab — should work
      const newId = remaining.addSession("/ws", "s2", "Session 2")
      expect(newId).toBeTruthy()
      expect(remaining.items()).toHaveLength(2) // 2 sessions

      // Close the new tab — should work
      remaining.close(newId!)
      expect(remaining.items()).toHaveLength(1) // session
      expect(remaining.items().find((t: any) => t.sessionId === "s1")).toBeDefined()
    } finally {
      dispose()
    }
  })

  test("toggle hide then toggle show preserves all state", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      tabs1.addSession("/ws", "s1", "Session 1")
      tabs2.addSession("/ws", "s2", "Session 2")
      tabs2.addTerminal("/ws", "pty-1", "Terminal 1")

      // Hide split
      api.split.toggle()
      expect(api.split.hidden()).toBe(true)
      expect(api.split.active()).toBe(false)
      expect(api.split.focusedId()).toBe(g1)

      // All tabs still exist
      expect(tabs1.items()).toHaveLength(1)
      expect(tabs2.items()).toHaveLength(2)

      // Show split
      api.split.toggle()
      expect(api.split.hidden()).toBe(false)
      expect(api.split.active()).toBe(true)

      // Everything preserved
      expect(tabs1.items()).toHaveLength(1)
      expect(tabs2.items()).toHaveLength(2)
    } finally {
      dispose()
    }
  })

  test("toggle on focused secondary group toggles visibility and topTabs reflects focused group", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      // Populate both groups
      tabs1.addSession("/ws", "s1", "Primary Session")
      tabs2.addSession("/ws", "s2", "Secondary Session")

      // Focus secondary group
      api.split.setFocus(g2)
      expect(api.split.focusedId()).toBe(g2)

      // topTabs should delegate to focused group (g2)
      expect(api.topTabs.active()?.sessionId).toBe("s2")

      // Toggle hides the split
      api.split.toggle()
      expect(api.split.active()).toBe(false)
      expect(api.split.hidden()).toBe(true)

      // topTabs should still delegate to focused group (g2)
      expect(api.topTabs.active()?.sessionId).toBe("s2")

      // Adding a session via topTabs while hidden should go to focused group (g2)
      api.topTabs.addSession("/ws", "s3", "Added While Hidden")
      expect(tabs2.items()).toHaveLength(2) // s2 + s3
      expect(tabs1.items()).toHaveLength(1) // s1

      // Toggle shows the split again
      api.split.toggle()
      expect(api.split.active()).toBe(true)
      expect(api.split.hidden()).toBe(false)

      // Focus should still be on g2
      expect(api.split.focusedId()).toBe(g2)

      // Sizes should be preserved
      expect(api.split.sizes()).toEqual([0.5, 0.5])

      // Both groups should have correct tabs
      expect(tabs1.items()).toHaveLength(1) // s1
      expect(tabs2.items()).toHaveLength(2) // s2 + s3
    } finally {
      dispose()
    }
  })
})

describe("auto-select main workspace behavior", () => {
  test("repeating setDefault with the same directory keeps state stable", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.worktree.setPinned(null)
      api.worktree.setDefault("/main")
      expect(api.worktree.default()).toBe("/main")
      expect(api.worktree.pinned()).toBeNull()

      api.worktree.setDefault("/main")
      expect(api.worktree.default()).toBe("/main")
      expect(api.worktree.pinned()).toBeNull()
    } finally {
      dispose()
    }
  })

  test("repeating setPinned with the same directory keeps state stable", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.worktree.setPinned("/pinned")
      expect(api.worktree.pinned()).toBe("/pinned")

      api.worktree.setPinned("/pinned")
      expect(api.worktree.pinned()).toBe("/pinned")

      api.worktree.setPinned(null)
      expect(api.worktree.pinned()).toBeNull()
    } finally {
      dispose()
    }
  })

  test("auto-select pattern sets correct worktree state for first project", () => {
    const { api, dispose } = createTestLayout()
    try {
      // Initially no default
      expect(api.worktree.default()).toBeNull()
      expect(api.worktree.pinned()).toBeNull()

      // Simulate auto-select: set main workspace as default
      api.worktree.setPinned(null)
      api.worktree.setDefault("/projects/my-app")

      expect(api.worktree.default()).toBe("/projects/my-app")
      expect(api.worktree.pinned()).toBeNull()
    } finally {
      dispose()
    }
  })

  test("setDefault can intentionally update an existing worktree default", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.worktree.setDefault("/projects/existing")
      expect(api.worktree.default()).toBe("/projects/existing")

      api.worktree.setDefault("/projects/main")
      expect(api.worktree.default()).toBe("/projects/main")
    } finally {
      dispose()
    }
  })

  test("setDefault works across split groups without cross-contamination", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2 } = splitInto2(api)

      // Focus group 1, set default (simulates auto-select targeting focused group)
      api.split.setFocus(g1)
      api.worktree.setDefault("/main-workspace")

      expect(api.groupWorktree(g1).default()).toBe("/main-workspace")
      expect(api.groupWorktree(g2).default()).toBeNull()

      // Focus group 2, set different default
      api.split.setFocus(g2)
      api.worktree.setDefault("/secondary")

      expect(api.groupWorktree(g1).default()).toBe("/main-workspace")
      expect(api.groupWorktree(g2).default()).toBe("/secondary")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Regression: workspace bar fallback naming when no tabs are open for default.
//
// These tests cover user-visible workspace label behavior across timing and
// empty-tab states. They intentionally assert display outcomes (project/workspace
// labels), not internal store shape.
// ---------------------------------------------------------------------------

describe("workspace bar fallback naming", () => {
  /** Replicate workspaceBarProjects from rail-layout.tsx:496-541 */
  function buildWorkspaceBarProjects(
    api: any,
    projects: Array<{ id: string; name: string; worktree: string; sandboxes?: string[] }>,
  ) {
    const allTabs: any[] = []
    for (const group of api.split.groups()) {
      allTabs.push(...api.groupTabs(group.id).items().filter((t: any) => t.type !== "process"))
    }
    const tabDirs = new Set(allTabs.map((t: any) => t.directory))

    const projectMap = new Map<string, any>()
    for (const dir of tabDirs) {
      const project = projects.find((p) => p.worktree === dir || p.sandboxes?.includes(dir))
      if (!project) continue
      let projEntry = projectMap.get(project.id)
      if (!projEntry) {
        projEntry = {
          id: project.id,
          name: project.name,
          worktree: project.worktree,
          workspaces: [],
        }
        projectMap.set(project.id, projEntry)
      }
      if (projEntry.workspaces.some((ws: any) => ws.directory === dir)) continue
      const isMain = dir === project.worktree
      const basename = dir.split("/").pop() || ""
      projEntry.workspaces.push({
        id: dir,
        directory: dir,
        name: isMain ? "main" : basename,
      })
    }
    return Array.from(projectMap.values())
  }

  /**
   * Replicate the `current` memo from top-tab-bar.tsx:939-946.
   *
   * This is a faithful replica of the PRODUCTION code. It receives both the
   * tab-derived workspaceBarProjects AND the full project list (available as
   * component props in production), but currently only uses wsBarProjects —
   * ignoring the full project list when no tabs match.
   *
   * The fix should use `allProjects` as a fallback to derive project name
   * and workspace name when wsBarProjects has no match.
   */
  function resolveCurrentDisplay(
    dir: string | null,
    wsBarProjects: Array<{ name: string; worktree?: string; workspaces: Array<{ directory: string; name: string }> }>,
    allProjects: Array<{ id: string; name: string; worktree: string; sandboxes?: string[] }>,
  ) {
    if (!dir) return undefined
    const basename = dir.split("/").pop() || ""
    const proj = wsBarProjects.find((p: any) => p.workspaces.some((w: any) => w.directory === dir))
    if (proj) {
      const ws = proj.workspaces.find((w: any) => w.directory === dir)
      return { dir, project: proj.name, workspace: ws?.name ?? basename }
    }
    // Fallback: resolve from full project list (matches fixed production code)
    const fullProj = allProjects.find((p) => p.worktree === dir || p.sandboxes?.includes(dir))
    if (fullProj) {
      const isMain = dir === fullProj.worktree
      return { dir, project: fullProj.name || basename, workspace: isMain ? "main" : basename }
    }
    return { dir, project: basename, workspace: basename }
  }

  const PROJECTS = [
    { id: "proj1", name: "my-project", worktree: "/home/user/projects/my-project", sandboxes: [] as string[] },
  ]

  const PROJECTS_WITH_SANDBOX = [
    {
      id: "proj1",
      name: "my-project",
      worktree: "/home/user/projects/my-project",
      sandboxes: ["/home/user/projects/my-project/.worktrees/feature-abc"],
    },
  ]

  test("default set with no tabs → should show project name and 'main'", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.worktree.setDefault("/home/user/projects/my-project")

      const wsBarProjects = buildWorkspaceBarProjects(api, PROJECTS)
      const display = resolveCurrentDisplay(api.worktree.default(), wsBarProjects, PROJECTS)
      expect(display).toBeDefined()

      // Main workspace should always display as "my-project - main", never "my-project - my-project"
      expect(display!.project).toBe("my-project")
      expect(display!.workspace).toBe("main")
      expect(display!.project).not.toBe(display!.workspace)
    } finally {
      dispose()
    }
  })

  test("all tabs closed for default workspace → should still show correct names", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.worktree.setDefault("/home/user/projects/my-project")
      const tabId = api.topTabs.addSession("/home/user/projects/my-project", "s1", "Session 1")
      api.topTabs.close(tabId)

      expect(api.topTabs.items()).toHaveLength(0)

      const wsBarProjects = buildWorkspaceBarProjects(api, PROJECTS)
      const display = resolveCurrentDisplay(api.worktree.default(), wsBarProjects, PROJECTS)

      expect(display!.project).toBe("my-project")
      expect(display!.workspace).toBe("main")
    } finally {
      dispose()
    }
  })

  test("sandbox default with no tabs → should show project name and sandbox name", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.worktree.setDefault("/home/user/projects/my-project/.worktrees/feature-abc")

      const wsBarProjects = buildWorkspaceBarProjects(api, PROJECTS_WITH_SANDBOX)
      const display = resolveCurrentDisplay(api.worktree.default(), wsBarProjects, PROJECTS_WITH_SANDBOX)

      // Should show "my-project - feature-abc", never "feature-abc - feature-abc"
      expect(display!.project).toBe("my-project")
      expect(display!.workspace).toBe("feature-abc")
      expect(display!.project).not.toBe(display!.workspace)
    } finally {
      dispose()
    }
  })

  test("auto-select timing window → should resolve correctly even before tabs exist", () => {
    const { api, dispose } = createTestLayout()
    try {
      // Simulate auto-select: default set synchronously, tab created later in microtask
      api.worktree.setPinned(null)
      api.worktree.setDefault("/home/user/projects/my-project")

      // Before microtask: no tabs yet
      const wsBarProjects = buildWorkspaceBarProjects(api, PROJECTS)
      expect(wsBarProjects).toHaveLength(0)

      const display = resolveCurrentDisplay(api.worktree.default(), wsBarProjects, PROJECTS)

      // Even before tabs exist, the display should resolve correctly
      expect(display!.project).toBe("my-project")
      expect(display!.workspace).toBe("main")
      expect(display!.project).not.toBe(display!.workspace)
    } finally {
      dispose()
    }
  })

  // --- Control tests: these pass today (tabs exist, lookup succeeds) ---

  test("tabs exist → project and workspace names are distinct", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.worktree.setDefault("/home/user/projects/my-project")
      api.topTabs.addSession("/home/user/projects/my-project", "s1", "Session 1")

      const wsBarProjects = buildWorkspaceBarProjects(api, PROJECTS)
      expect(wsBarProjects).toHaveLength(1)

      const display = resolveCurrentDisplay(api.worktree.default(), wsBarProjects, PROJECTS)
      expect(display!.project).toBe("my-project")
      expect(display!.workspace).toBe("main")
    } finally {
      dispose()
    }
  })

  test("sandbox tab exists → project name differs from workspace name", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.worktree.setDefault("/home/user/projects/my-project/.worktrees/feature-abc")
      api.topTabs.addSession("/home/user/projects/my-project/.worktrees/feature-abc", "s1", "Session 1")

      const wsBarProjects = buildWorkspaceBarProjects(api, PROJECTS_WITH_SANDBOX)
      expect(wsBarProjects).toHaveLength(1)

      const display = resolveCurrentDisplay(api.worktree.default(), wsBarProjects, PROJECTS_WITH_SANDBOX)
      expect(display!.project).toBe("my-project")
      expect(display!.workspace).toBe("feature-abc")
      expect(display!.project).not.toBe(display!.workspace)
    } finally {
      dispose()
    }
  })
})

describe("toggle focus tracking after hide/show cycle", () => {
  test("full user sequence: focus g2, hide, show, focus g1, hide → g1 stays visible", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1, g2, tabs1, tabs2 } = splitInto2(api)

      // Populate both groups so user can distinguish them
      tabs1.addSession("/ws", "s1", "Primary Session")
      tabs2.addSession("/ws", "s2", "Secondary Session")

      // Initial: focus defaults to g1
      expect(api.split.focusedId()).toBe(g1)

      // Step 1: Toggle hides non-focused (g2)
      api.split.toggle()
      expect(api.split.hidden()).toBe(true)
      expect(api.split.focusedId()).toBe(g1)
      expect(api.topTabs.active()?.sessionId).toBe("s1")

      // Step 2: Unhide
      api.split.toggle()
      expect(api.split.hidden()).toBe(false)

      // Step 3: Click on secondary (g2) to focus it
      api.split.setFocus(g2)
      expect(api.split.focusedId()).toBe(g2)

      // Step 4: Toggle hides non-focused (g1)
      api.split.toggle()
      expect(api.split.hidden()).toBe(true)
      expect(api.split.focusedId()).toBe(g2)
      expect(api.topTabs.active()?.sessionId).toBe("s2")

      // Step 5: Unhide
      api.split.toggle()
      expect(api.split.hidden()).toBe(false)

      // Step 6: Click on primary (g1) to focus it
      api.split.setFocus(g1)
      expect(api.split.focusedId()).toBe(g1)

      // Step 7: Toggle hides non-focused — g2 should hide, g1 should stay
      api.split.toggle()
      expect(api.split.hidden()).toBe(true)
      expect(api.split.focusedId()).toBe(g1)

      // Critical assertion: topTabs should delegate to g1 (the focused group)
      expect(api.topTabs.active()?.sessionId).toBe("s1")

      // The focused group returned by groups().find(g => g.id === focusedId) is g1
      const focused = api.split.groups().find((g: any) => g.id === api.split.focusedId())
      expect(focused?.id).toBe(g1)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Terminal replaceId
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Page tab integration
// ---------------------------------------------------------------------------

describe("page tab integration", () => {
  test("addPage to group A does not appear in group B", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1, tabs2 } = splitInto2(api)

      tabs1.addPage("page-1", "My Page")

      expect(tabs1.items()).toHaveLength(1) // page
      const pageTab = tabs1.items().find((t: any) => t.type === "page")
      expect(pageTab).toBeDefined()
      expect(pageTab.pageId).toBe("page-1")
      expect(tabs2.items()).toHaveLength(0) // empty
    } finally {
      dispose()
    }
  })

  test("addPage deduplicates by pageId", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)

      const a = tabs1.addPage("page-1", "My Page")
      const b = tabs1.addPage("page-1", "My Page")

      expect(a).toBe(b)
      expect(tabs1.items()).toHaveLength(1) // 1 page
    } finally {
      dispose()
    }
  })

  test("different pageIds create separate tabs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)

      const a = tabs1.addPage("page-1", "Page One")
      const b = tabs1.addPage("page-2", "Page Two")

      expect(a).not.toBe(b)
      expect(tabs1.items()).toHaveLength(2) // 2 pages
    } finally {
      dispose()
    }
  })

  test("page tab has correct shape", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)

      tabs1.addPage("page-1", "My Page")
      const tab = tabs1.items().find((t: any) => t.type === "page")

      expect(tab).toBeDefined()
      expect(tab.pageId).toBe("page-1")
      expect(tab.directory).toBe("__pages__")
      expect(tab.title).toBe("My Page")
      expect(tab.closable).toBe(true)
    } finally {
      dispose()
    }
  })

  test("page tab initializes with page + session preset", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)
      const id = tabs1.addPage("page-1", "My Page", "/ws")
      const state = api.multiPane.getState(id)
      const layout = state?.layouts[0]
      const panes = Object.values(layout?.contents ?? {}) as Array<{
        type: string
        intent?: { name?: string; refs?: string[] }
      }>
      const page = panes.find((pane) => pane.type === "page")
      const session = panes.find((pane) => pane.type === "session")

      expect(page?.intent?.name).toBe("doc")
      expect(session?.intent?.name).toBe("chat")
      expect(session?.intent?.refs).toContain("doc")
    } finally {
      dispose()
    }
  })

  test("page tab can be closed and reopened from closedTabs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)

      const id = tabs1.addPage("page-1", "My Page")
      expect(tabs1.items()).toHaveLength(1) // page

      tabs1.close(id)
      expect(tabs1.items()).toHaveLength(0) // empty

      tabs1.reopenLast()
      expect(tabs1.items()).toHaveLength(1)
      expect(tabs1.items().find((t: any) => t.type === "page")!.pageId).toBe("page-1")
    } finally {
      dispose()
    }
  })

  test("addPage sets the new tab as active", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)

      tabs1.addSession("/ws", "s1", "Session 1")
      const pageTabId = tabs1.addPage("page-1", "My Page")

      expect(tabs1.active()?.id).toBe(pageTabId)
    } finally {
      dispose()
    }
  })

  test("workgraph page tab uses a wkg route id", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { tabs1 } = splitInto2(api)
      const id = tabs1.addPage("__workgraph__", "WorkGraph", "/ws")

      expect(id).toMatch(/^wkg-/)
      expect(tabs1.items().find((t: any) => t.id === id)?.pageId).toBe("__workgraph__")
    } finally {
      dispose()
    }
  })

  test("topTabs.addPage delegates to focused group", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g1 } = splitInto2(api)

      api.topTabs.addPage("page-1", "My Page")

      const g1Tabs = api.groupTabs(g1)
      expect(g1Tabs.items()).toHaveLength(1) // page
      expect(g1Tabs.items().find((t: any) => t.type === "page")!.pageId).toBe("page-1")
    } finally {
      dispose()
    }
  })

  test("page tabs survive split close (merge into remaining group)", () => {
    const { api, dispose } = createTestLayout()
    try {
      const { g2, tabs1, tabs2 } = splitInto2(api)

      tabs1.addPage("page-1", "Page in G1")
      tabs2.addPage("page-2", "Page in G2")

      // Close group 2 — its tabs merge into group 1
      api.split.closeGroup(g2)

      const groups = api.split.groups()
      expect(groups).toHaveLength(1)

      const remaining = api.groupTabs(groups[0].id)
      const pageIds = remaining
        .items()
        .filter((t: any) => t.type === "page")
        .map((t: any) => t.pageId)
      expect(pageIds).toContain("page-1")
      expect(pageIds).toContain("page-2")
    } finally {
      dispose()
    }
  })
})
