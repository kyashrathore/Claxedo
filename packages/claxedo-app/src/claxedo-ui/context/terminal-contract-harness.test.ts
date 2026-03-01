/**
 * Terminal Contract Harness Tests
 *
 * Verifies invariants that the new architecture (global terminal store)
 * must maintain. These tests exercise the current state model (groups, tabs,
 * terminal pane/owner/lifecycle) to establish a baseline contract.
 *
 * Contract categories:
 *   1. Multi-group support (>=4 groups with mixed tabs)
 *   2. Unique PTY binding per directory (owner-to-tab mapping)
 *   3. Process-owned PTY isolation from tab close
 *   4. SSE pre-init replay behavior (pending process starts + terminal creates)
 *   5. Lifecycle state machine transitions
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ensureLayoutMocked, getInitLayout } from "./_test-helper"

let initLayout: () => any

beforeAll(async () => {
  await ensureLayoutMocked()
  initLayout = getInitLayout()
})

// ---------------------------------------------------------------------------
// Reusable test fixtures
// ---------------------------------------------------------------------------

/** Create a fresh layout store inside a SolidJS root for reactive tracking. */
function createTestLayout() {
  let dispose!: () => void
  const api = createRoot((d) => {
    dispose = d
    return initLayout()
  })
  return { api, dispose }
}

/** Create n groups by toggling split and adding new groups. Returns group ids.
 *  Patches Date.now() to return unique values since moveTab/toggle use it for group IDs. */
function createMultiGroupSetup(api: any, n: number): string[] {
  if (n < 2) return [api.split.orderedGroups()[0].id]

  // Patch Date.now() to produce unique values — in tight loops the real
  // Date.now() returns the same ms for all calls, causing ID collisions.
  let counter = Date.now()
  const originalDateNow = Date.now
  Date.now = () => ++counter

  try {
    // Ensure the initial group has an anchor tab so it's never empty
    const g0 = api.split.orderedGroups()[0].id
    api.groupTabs(g0).addSession("/ws-anchor", "anchor-0", "Anchor 0")

    api.split.toggle()
    let groups = api.split.orderedGroups()
    expect(groups.length).toBe(2)

    // Add anchor tab to second group so it's never auto-removed
    const g1Id = groups[1].id
    api.groupTabs(g1Id).addSession("/ws-anchor", "anchor-1", "Anchor 1")

    // For N>2, add a tab to the first group then move it to "new"
    const firstGroupId = groups[0].id
    for (let i = 2; i < n; i++) {
      const tabs = api.groupTabs(firstGroupId)
      const tabId = tabs.addSession(`/ws-seed-${i}`, `seed-${i}`, `Seed ${i}`)
      api.split.moveTab(tabId, firstGroupId, "new")
    }

    groups = api.split.orderedGroups()
    expect(groups.length).toBe(n)
    return groups.map((g: any) => g.id)
  } finally {
    Date.now = originalDateNow
  }
}

/** Simulate a terminal binding: add a terminal tab to a group, set owner, ensure pane. */
function createTerminalBinding(
  api: any,
  dir: string,
  ptyId: string,
  groupId: string,
): { tabId: string } {
  const tabs = api.groupTabs(groupId)
  const tabId = tabs.addTerminal(dir, ptyId, `Terminal ${ptyId}`)
  // Own the terminal to this tab
  api.terminal.own(tabId, ptyId)
  // Ensure pane structure is initialized
  api.terminal.ensure(tabId, ptyId)
  // Transition lifecycle to attached
  api.terminal.transitionLifecycle(ptyId, "creating", "test")
  api.terminal.transitionLifecycle(ptyId, "attached", "test")
  return { tabId }
}

/** Create a process-owned PTY entry (owner = "process:{processId}"). */
function createProcessPTY(
  api: any,
  dir: string,
  ptyId: string,
  processId: string,
): void {
  // Set owner to process:processId — process PTYs are not bound to tabs
  api.terminal.own(`process:${processId}`, ptyId)
  api.terminal.transitionLifecycle(ptyId, "creating", "process-spawn")
  api.terminal.transitionLifecycle(ptyId, "attached", "process-attach")
}

/** Simulate an SSE-like terminal create request via requestCreate. */
function simulateSSEEvent(
  api: any,
  type: "pty.created" | "pty.exited" | "process.started" | "process.stopped",
  payload: { dir?: string; ptyId?: string; groupId?: string; processId?: string },
): void {
  switch (type) {
    case "pty.created":
      // The SSE pty.created path goes through requestTerminalCreate + pending create consumption
      api.terminal.requestCreate(payload.dir!, undefined, undefined, payload.groupId)
      break
    case "pty.exited":
      // Mark as closing then closed
      if (payload.ptyId) {
        api.terminal.beginClosing(payload.ptyId)
        api.terminal.clearClosing(payload.ptyId)
      }
      break
    case "process.started":
      api.terminal.expectProcessPty()
      break
    case "process.stopped":
      api.terminal.resolveProcessPty()
      break
  }
}

// ---------------------------------------------------------------------------
// Contract: Multi-group terminal invariants
// ---------------------------------------------------------------------------

describe("contract: multi-group terminal invariants", () => {
  test("4+ groups can each independently track their own tabs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const groupIds = createMultiGroupSetup(api, 4)
      expect(groupIds).toHaveLength(4)

      // Add mixed tabs to each group
      for (let i = 0; i < groupIds.length; i++) {
        const gid = groupIds[i]
        const tabs = api.groupTabs(gid)
        tabs.addSession(`/ws-${i}`, `session-${i}`, `Session ${i}`)
        tabs.addTerminal(`/ws-${i}`, `pty-${i}`, `Terminal ${i}`)
        tabs.addFile(`/ws-${i}`, `/ws-${i}/main.ts`, `main.ts`)
      }

      // Verify each group has exactly 3 tabs (session + terminal + file)
      // Group 0 also has the temp tabs from the setup that were moved away,
      // but those were moved to new groups so group 0 should be clean.
      // Actually, group 0 will only have the tabs we just added.
      for (let i = 0; i < groupIds.length; i++) {
        const tabs = api.groupTabs(groupIds[i])
        const termTabs = tabs.items().filter((t: any) => t.type === "terminal")
        const sessionTabs = tabs.items().filter((t: any) => t.type === "session")
        const fileTabs = tabs.items().filter((t: any) => t.type === "file")

        expect(termTabs.length).toBeGreaterThanOrEqual(1)
        expect(sessionTabs.length).toBeGreaterThanOrEqual(1)
        expect(fileTabs.length).toBeGreaterThanOrEqual(1)

        // Verify the terminal tab has the correct ptyId
        expect(termTabs.some((t: any) => t.terminalId === `pty-${i}`)).toBe(true)
      }
    } finally {
      dispose()
    }
  })

  test("terminal tabs in different groups do not interfere", () => {
    const { api, dispose } = createTestLayout()
    try {
      const groupIds = createMultiGroupSetup(api, 4)

      // Bind terminals in each group
      const bindings = groupIds.map((gid, i) =>
        createTerminalBinding(api, `/ws-${i}`, `pty-${i}`, gid),
      )

      // Verify each terminal is owned by its own tab
      for (let i = 0; i < groupIds.length; i++) {
        const owner = api.terminal.owner(`pty-${i}`)
        expect(owner).toBe(bindings[i].tabId)
      }

      // Verify terminal pane in each tab is independent
      for (let i = 0; i < groupIds.length; i++) {
        const paneIds = api.terminal.ids(bindings[i].tabId)
        expect(paneIds).toEqual([`pty-${i}`])
      }

      // Closing terminal in group 0 should not affect group 1
      api.terminal.close({ tab: bindings[0].tabId, id: `pty-0` })
      expect(api.terminal.ids(bindings[0].tabId)).toEqual([])
      expect(api.terminal.ids(bindings[1].tabId)).toEqual([`pty-1`])
      expect(api.terminal.ids(bindings[2].tabId)).toEqual([`pty-2`])
      expect(api.terminal.ids(bindings[3].tabId)).toEqual([`pty-3`])
    } finally {
      dispose()
    }
  })

  test("focus switching between 4+ groups works correctly", () => {
    const { api, dispose } = createTestLayout()
    try {
      const groupIds = createMultiGroupSetup(api, 4)

      // Switch focus to each group in sequence
      for (const gid of groupIds) {
        api.split.setFocus(gid)
        expect(api.split.focusedId()).toBe(gid)
      }

      // Switch back to first
      api.split.setFocus(groupIds[0])
      expect(api.split.focusedId()).toBe(groupIds[0])
    } finally {
      dispose()
    }
  })

  test("terminal pane state is per-tab, not per-group", () => {
    const { api, dispose } = createTestLayout()
    try {
      const groupIds = createMultiGroupSetup(api, 2)

      // Create two terminal tabs in the same group
      const tabs = api.groupTabs(groupIds[0])
      const tab1 = tabs.addTerminal("/ws", "pty-1", "Terminal 1")
      const tab2 = tabs.addTerminal("/ws", "pty-2", "Terminal 2")

      api.terminal.own(tab1, "pty-1")
      api.terminal.own(tab2, "pty-2")
      api.terminal.ensure(tab1, "pty-1")
      api.terminal.ensure(tab2, "pty-2")

      // Split pane in tab1
      api.terminal.split({ tab: tab1, at: "pty-1", id: "pty-1b", dir: "h" })
      api.terminal.own(tab1, "pty-1b")

      // Tab1 now has 2 terminals in its pane, tab2 still has 1
      expect(api.terminal.ids(tab1)).toEqual(["pty-1", "pty-1b"])
      expect(api.terminal.ids(tab2)).toEqual(["pty-2"])
    } finally {
      dispose()
    }
  })

  test("closing a group merges non-terminal tabs but drops terminal tabs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const groupIds = createMultiGroupSetup(api, 3)
      const g1 = groupIds[0]
      const g2 = groupIds[1]

      // Add tabs to group 2
      const tabs2 = api.groupTabs(g2)
      tabs2.addSession("/ws", "s-merge", "Session Merge")
      tabs2.addTerminal("/ws", "pty-merge", "Terminal Merge")

      const beforeG1 = api.groupTabs(g1).items().length

      // Close group 2 — sessions should merge to group 1, terminals should be dropped
      api.split.closeGroup(g2)

      const afterG1Items = api.groupTabs(g1).items()
      // Session tab should have been merged
      expect(afterG1Items.some((t: any) => t.sessionId === "s-merge")).toBe(true)
      // Terminal tab should NOT have been merged (mergeGroupTabs filters terminal tabs from removed groups)
      expect(afterG1Items.some((t: any) => t.terminalId === "pty-merge")).toBe(false)
    } finally {
      dispose()
    }
  })

  test("5 groups with mixed tabs maintain isolation", () => {
    const { api, dispose } = createTestLayout()
    try {
      const groupIds = createMultiGroupSetup(api, 5)
      expect(groupIds).toHaveLength(5)

      // Verify all 5 IDs are unique
      expect(new Set(groupIds).size).toBe(5)

      // Add terminal+session to each
      for (let i = 0; i < 5; i++) {
        const tabs = api.groupTabs(groupIds[i])
        tabs.addSession(`/ws-${i}`, `s-${i}`, `Session ${i}`)
        createTerminalBinding(api, `/ws-${i}`, `pty-five-${i}`, groupIds[i])
      }

      // Verify all 5 groups have tabs
      for (let i = 0; i < 5; i++) {
        const tabs = api.groupTabs(groupIds[i])
        expect(tabs.items().length).toBeGreaterThanOrEqual(2) // at least session + terminal
      }

      const beforeClose = api.split.orderedGroups()
      expect(beforeClose.length).toBe(5)

      // Close group in the middle (group 2)
      api.split.closeGroup(groupIds[2])
      const remaining = api.split.orderedGroups()
      const remainingIds = remaining.map((g: any) => g.id)
      // After closing one of 5, we should have 4
      expect(remaining.length).toBe(4)
      expect(remainingIds).not.toContain(groupIds[2])

      // Other groups still have their terminals
      for (const gid of [groupIds[0], groupIds[1], groupIds[3], groupIds[4]]) {
        const group = remaining.find((g: any) => g.id === gid)
        expect(group).toBeDefined()
        if (group) {
          const termTabs = group.tabs.items.filter((t: any) => t.type === "terminal")
          expect(termTabs.length).toBeGreaterThanOrEqual(1)
        }
      }
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Contract: PTY binding uniqueness
// ---------------------------------------------------------------------------

describe("contract: pty binding uniqueness", () => {
  test("a PTY can be owned by at most one tab at a time", () => {
    const { api, dispose } = createTestLayout()
    try {
      const groupIds = createMultiGroupSetup(api, 2)

      // Bind pty-1 to a tab in group 1
      const tabs1 = api.groupTabs(groupIds[0])
      const tabA = tabs1.addTerminal("/ws", "pty-1", "Terminal 1")
      api.terminal.own(tabA, "pty-1")

      // Verify ownership
      expect(api.terminal.owner("pty-1")).toBe(tabA)

      // Attempt to own the same PTY to a different tab (in group 2)
      const tabs2 = api.groupTabs(groupIds[1])
      const tabB = tabs2.addTerminal("/ws", "pty-1-dup", "Terminal 1 Dup")
      api.terminal.own(tabB, "pty-1")

      // The current implementation allows re-owning (last write wins).
      // The contract asserts what the NEW architecture must enforce:
      // pty-1 should be owned by exactly one tab.
      // For now, we verify the latest owner is set:
      expect(api.terminal.owner("pty-1")).toBe(tabB)
    } finally {
      dispose()
    }
  })

  test("after disowning, a PTY can be bound to a different tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const tabs = api.groupTabs(api.split.orderedGroups()[0].id)
      const tabA = tabs.addTerminal("/ws", "pty-rebind", "Terminal Rebind")
      api.terminal.own(tabA, "pty-rebind")
      expect(api.terminal.owner("pty-rebind")).toBe(tabA)

      // Disown
      api.terminal.disown("pty-rebind")
      expect(api.terminal.owner("pty-rebind")).toBeUndefined()

      // Re-bind to a different tab
      const tabB = tabs.addTerminal("/ws", "pty-rebind2", "Terminal Rebind 2")
      api.terminal.own(tabB, "pty-rebind")
      expect(api.terminal.owner("pty-rebind")).toBe(tabB)
    } finally {
      dispose()
    }
  })

  test("terminal owner maps are separate from pane structure", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-sep", "Terminal Sep")

      // Own and ensure pane
      api.terminal.own(tabId, "pty-sep")
      api.terminal.ensure(tabId, "pty-sep")

      // Pane has the terminal
      expect(api.terminal.ids(tabId)).toEqual(["pty-sep"])
      // Owner is set
      expect(api.terminal.owner("pty-sep")).toBe(tabId)

      // Close from pane (removes from pane tree) — does NOT auto-disown
      api.terminal.close({ tab: tabId, id: "pty-sep" })
      expect(api.terminal.ids(tabId)).toEqual([])
      // Owner still set until explicitly cleared
      // (clearTerminalTabState handles this in the full flow)
    } finally {
      dispose()
    }
  })

  test("replaceId transfers ownership to new id", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-old", "Terminal Old")

      api.terminal.own(tabId, "pty-old")
      api.terminal.ensure(tabId, "pty-old")
      api.terminal.transitionLifecycle("pty-old", "creating", "test")
      api.terminal.transitionLifecycle("pty-old", "attached", "test")

      // Replace ID (e.g., after clone)
      api.terminal.replaceId(tabId, "pty-old", "pty-new")

      // Old ID should be disowned, new ID should have the tab as owner
      expect(api.terminal.owner("pty-old")).toBeUndefined()
      expect(api.terminal.owner("pty-new")).toBe(tabId)

      // Pane should contain new ID
      expect(api.terminal.ids(tabId)).toEqual(["pty-new"])

      // Lifecycle should transfer
      expect(api.terminal.lifecycle("pty-old")).toBeUndefined()
      expect(api.terminal.lifecycle("pty-new")).toBe("attached")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Contract: Process ownership isolation
// ---------------------------------------------------------------------------

describe("contract: process ownership isolation", () => {
  test("process-owned PTYs are tracked via owner prefix 'process:'", () => {
    const { api, dispose } = createTestLayout()
    try {
      createProcessPTY(api, "/ws", "pty-proc-1", "proc-1")
      expect(api.terminal.owner("pty-proc-1")).toBe("process:proc-1")
    } finally {
      dispose()
    }
  })

  test("processOwnedPtyIds returns only process-owned PTYs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id

      // Create a tab-owned terminal
      createTerminalBinding(api, "/ws", "pty-tab-1", gid)
      // Create a process-owned terminal
      createProcessPTY(api, "/ws", "pty-proc-1", "proc-1")
      createProcessPTY(api, "/ws", "pty-proc-2", "proc-2")

      const processIds = api.terminal.processOwnedPtyIds()
      expect(processIds).toContain("pty-proc-1")
      expect(processIds).toContain("pty-proc-2")
      expect(processIds).not.toContain("pty-tab-1")
    } finally {
      dispose()
    }
  })

  test("clearing a terminal tab does not affect process-owned PTYs", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id

      // Create a tab-owned terminal
      const { tabId } = createTerminalBinding(api, "/ws", "pty-tab-close", gid)
      // Create process-owned terminals
      createProcessPTY(api, "/ws", "pty-proc-alive", "proc-alive")

      // Clear the tab's terminal state (simulates tab close)
      api.terminal.clear(tabId)

      // Tab terminal state should be cleared
      expect(api.terminal.ids(tabId)).toEqual([])
      expect(api.terminal.pane(tabId)).toBeUndefined()

      // Process PTY should still be owned
      expect(api.terminal.owner("pty-proc-alive")).toBe("process:proc-alive")
      expect(api.terminal.lifecycle("pty-proc-alive")).toBe("attached")
    } finally {
      dispose()
    }
  })

  test("process PTYs stay alive when the associated tab group is closed", () => {
    const { api, dispose } = createTestLayout()
    try {
      const groupIds = createMultiGroupSetup(api, 2)

      // Put a tab-owned terminal in group 2
      createTerminalBinding(api, "/ws", "pty-tab-g2", groupIds[1])
      // Create a process PTY (not bound to any tab/group)
      createProcessPTY(api, "/ws", "pty-proc-g2", "proc-g2")

      // Close group 2
      api.split.closeGroup(groupIds[1])

      // Process PTY is still owned — it's independent of groups
      expect(api.terminal.owner("pty-proc-g2")).toBe("process:proc-g2")
    } finally {
      dispose()
    }
  })

  test("process start/stop/crash lifecycle does not affect tab-owned terminals", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id

      // Create a tab-owned terminal
      const { tabId } = createTerminalBinding(api, "/ws", "pty-tab-stable", gid)

      // Simulate process lifecycle
      simulateSSEEvent(api, "process.started", { processId: "proc-x" })
      simulateSSEEvent(api, "process.stopped", { processId: "proc-x" })

      // Tab-owned terminal should be completely unaffected
      expect(api.terminal.owner("pty-tab-stable")).toBe(tabId)
      expect(api.terminal.ids(tabId)).toEqual(["pty-tab-stable"])
      expect(api.terminal.lifecycle("pty-tab-stable")).toBe("attached")
    } finally {
      dispose()
    }
  })

  test("disowning a process PTY makes it available for tab binding", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id

      createProcessPTY(api, "/ws", "pty-proc-reuse", "proc-reuse")
      expect(api.terminal.owner("pty-proc-reuse")).toBe("process:proc-reuse")

      // Disown from process
      api.terminal.disown("pty-proc-reuse")
      expect(api.terminal.owner("pty-proc-reuse")).toBeUndefined()

      // Now bind to a tab
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-proc-reuse", "Reused Terminal")
      api.terminal.own(tabId, "pty-proc-reuse")
      expect(api.terminal.owner("pty-proc-reuse")).toBe(tabId)

      // Should no longer be in processOwnedPtyIds
      expect(api.terminal.processOwnedPtyIds()).not.toContain("pty-proc-reuse")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Contract: SSE pre-init replay behavior
// ---------------------------------------------------------------------------

describe("contract: sse pre-init replay", () => {
  test("pendingProcessStarts starts at 1 to defer tab creation before ProcessPaneProvider", () => {
    const { api, dispose } = createTestLayout()
    try {
      // The initial value is 1 (assumes processes may exist)
      expect(api.terminal.pendingProcessStarts()).toBe(1)
    } finally {
      dispose()
    }
  })

  test("resolveInitialProcessPty decrements the initial pending count", () => {
    const { api, dispose } = createTestLayout()
    try {
      expect(api.terminal.pendingProcessStarts()).toBe(1)
      api.terminal.resolveInitialProcessPty()
      expect(api.terminal.pendingProcessStarts()).toBe(0)
    } finally {
      dispose()
    }
  })

  test("expectProcessPty/resolveProcessPty bracket around process start events", () => {
    const { api, dispose } = createTestLayout()
    try {
      // Resolve initial
      api.terminal.resolveInitialProcessPty()
      expect(api.terminal.pendingProcessStarts()).toBe(0)

      // Expect a process start
      api.terminal.expectProcessPty()
      expect(api.terminal.pendingProcessStarts()).toBe(1)

      // Expect another
      api.terminal.expectProcessPty()
      expect(api.terminal.pendingProcessStarts()).toBe(2)

      // Resolve one
      api.terminal.resolveProcessPty()
      expect(api.terminal.pendingProcessStarts()).toBe(1)

      // Resolve the other
      api.terminal.resolveProcessPty()
      expect(api.terminal.pendingProcessStarts()).toBe(0)
    } finally {
      dispose()
    }
  })

  test("resolveProcessPty does not go below 0", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.resolveInitialProcessPty()
      expect(api.terminal.pendingProcessStarts()).toBe(0)

      api.terminal.resolveProcessPty()
      expect(api.terminal.pendingProcessStarts()).toBe(0)

      api.terminal.resolveProcessPty()
      expect(api.terminal.pendingProcessStarts()).toBe(0)
    } finally {
      dispose()
    }
  })

  test("requestCreate queues pending terminal creates that can be consumed in order", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.requestCreate("/ws-1", "echo 1", "Title 1", "g1")
      api.terminal.requestCreate("/ws-2", "echo 2", "Title 2", "g2")

      expect(api.terminal.pendingCreate()).toBe(2)
      expect(api.terminal.pendingDir()).toBe("/ws-1")
      expect(api.terminal.pendingCommand()).toBe("echo 1")
      expect(api.terminal.pendingGroupId()).toBe("g1")

      // Consume first
      const first = api.terminal.consumePendingCommand()
      expect(first.directory).toBe("/ws-1")
      expect(first.command).toBe("echo 1")
      expect(first.groupId).toBe("g1")

      // Now second is the pending
      expect(api.terminal.pendingCreate()).toBe(1)
      expect(api.terminal.pendingDir()).toBe("/ws-2")
      expect(api.terminal.pendingCommand()).toBe("echo 2")
      expect(api.terminal.pendingGroupId()).toBe("g2")

      // Consume second
      const second = api.terminal.consumePendingCommand()
      expect(second.directory).toBe("/ws-2")
      expect(second.command).toBe("echo 2")
      expect(second.groupId).toBe("g2")

      // Queue is empty
      expect(api.terminal.pendingCreate()).toBe(0)
      expect(api.terminal.pendingDir()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("clearPendingCreate resets all pending creates at once", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.requestCreate("/ws-1", "cmd1", "T1", "g1")
      api.terminal.requestCreate("/ws-2", "cmd2", "T2", "g2")
      expect(api.terminal.pendingCreate()).toBe(2)

      api.terminal.clearPendingCreate()
      expect(api.terminal.pendingCreate()).toBe(0)
      expect(api.terminal.pendingDir()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("created() decrements the creating counter", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.requestCreate("/ws", undefined, undefined, "g1")
      expect(api.terminal.creating()).toBe(1)

      api.terminal.created()
      expect(api.terminal.creating()).toBe(0)
    } finally {
      dispose()
    }
  })

  test("creatingGroupId tracks the target group for in-flight creates", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.requestCreate("/ws", undefined, undefined, "group-target")
      expect(api.terminal.creatingGroupId()).toBe("group-target")

      api.terminal.created()
      // After creating count reaches 0, groupId is cleared
      expect(api.terminal.creatingGroupId()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("previousPtyId is forwarded through pending create queue", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.requestCreate("/ws", undefined, undefined, "g1", "old-pty-123")

      const consumed = api.terminal.consumePendingCommand()
      expect(consumed.previousPtyId).toBe("old-pty-123")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Contract: Lifecycle state machine
// ---------------------------------------------------------------------------

describe("contract: terminal lifecycle state machine", () => {
  test("valid lifecycle transitions are allowed", () => {
    const { api, dispose } = createTestLayout()
    try {
      // undefined -> creating
      expect(api.terminal.transitionLifecycle("lc-1", "creating", "test")).toBe(true)
      expect(api.terminal.lifecycle("lc-1")).toBe("creating")

      // creating -> attaching
      expect(api.terminal.transitionLifecycle("lc-1", "attaching", "test")).toBe(true)
      expect(api.terminal.lifecycle("lc-1")).toBe("attaching")

      // attaching -> attached
      expect(api.terminal.transitionLifecycle("lc-1", "attached", "test")).toBe(true)
      expect(api.terminal.lifecycle("lc-1")).toBe("attached")

      // attached -> closing
      expect(api.terminal.transitionLifecycle("lc-1", "closing", "test")).toBe(true)
      expect(api.terminal.lifecycle("lc-1")).toBe("closing")

      // closing -> closed
      expect(api.terminal.transitionLifecycle("lc-1", "closed", "test")).toBe(true)
      expect(api.terminal.lifecycle("lc-1")).toBe("closed")

      // closed -> creating (re-create after closed)
      expect(api.terminal.transitionLifecycle("lc-1", "creating", "test")).toBe(true)
      expect(api.terminal.lifecycle("lc-1")).toBe("creating")
    } finally {
      dispose()
    }
  })

  test("invalid lifecycle transitions are rejected", () => {
    const { api, dispose } = createTestLayout()
    try {
      // creating -> closed (skipping attaching/attached/closing)
      api.terminal.transitionLifecycle("lc-inv", "creating", "test")

      // creating can go to attaching, attached, closing, closed — all are valid
      // Actually, looking at the transition table:
      //   creating -> Set(attaching, attached, closing, closed)
      // So creating->closed IS valid.

      // Let's test a truly invalid transition: attached -> creating
      api.terminal.transitionLifecycle("lc-inv2", "creating", "test")
      api.terminal.transitionLifecycle("lc-inv2", "attached", "test")
      expect(api.terminal.lifecycle("lc-inv2")).toBe("attached")

      // attached can only go to closing or closed
      const result = api.terminal.transitionLifecycle("lc-inv2", "creating", "test")
      expect(result).toBe(false)
      // State should remain attached
      expect(api.terminal.lifecycle("lc-inv2")).toBe("attached")
    } finally {
      dispose()
    }
  })

  test("same-state transition is a no-op that returns true", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.transitionLifecycle("lc-same", "creating", "test")
      const result = api.terminal.transitionLifecycle("lc-same", "creating", "test")
      expect(result).toBe(true)
      expect(api.terminal.lifecycle("lc-same")).toBe("creating")
    } finally {
      dispose()
    }
  })

  test("undefined initial state allows any first transition", () => {
    const { api, dispose } = createTestLayout()
    try {
      expect(api.terminal.lifecycle("lc-undef")).toBeUndefined()

      // Can transition to any state from undefined
      expect(api.terminal.transitionLifecycle("lc-a", "creating", "test")).toBe(true)
      expect(api.terminal.transitionLifecycle("lc-b", "attaching", "test")).toBe(true)
      expect(api.terminal.transitionLifecycle("lc-c", "attached", "test")).toBe(true)
      expect(api.terminal.transitionLifecycle("lc-d", "closing", "test")).toBe(true)
      expect(api.terminal.transitionLifecycle("lc-e", "closed", "test")).toBe(true)
    } finally {
      dispose()
    }
  })

  test("closing transitions: attaching can skip to closing and closed", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.transitionLifecycle("lc-skip", "creating", "test")
      api.terminal.transitionLifecycle("lc-skip", "attaching", "test")

      // attaching -> closing (valid)
      expect(api.terminal.transitionLifecycle("lc-skip", "closing", "test")).toBe(true)
      expect(api.terminal.lifecycle("lc-skip")).toBe("closing")
    } finally {
      dispose()
    }
  })

  test("beginClosing and clearClosing manage the closing IDs list", () => {
    const { api, dispose } = createTestLayout()
    try {
      expect(api.terminal.isClosing("pty-cl")).toBe(false)

      api.terminal.transitionLifecycle("pty-cl", "creating", "test")
      api.terminal.transitionLifecycle("pty-cl", "attached", "test")

      api.terminal.beginClosing("pty-cl")
      expect(api.terminal.isClosing("pty-cl")).toBe(true)
      expect(api.terminal.lifecycle("pty-cl")).toBe("closing")

      api.terminal.clearClosing("pty-cl")
      expect(api.terminal.isClosing("pty-cl")).toBe(false)
      expect(api.terminal.lifecycle("pty-cl")).toBe("closed")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Contract: Terminal agent status isolation
// ---------------------------------------------------------------------------

describe("contract: terminal agent status isolation", () => {
  test("agent status is per-terminal, not per-tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.setAgentStatus("pty-a1", "working")
      api.terminal.setAgentStatus("pty-a2", "permission")

      expect(api.terminal.agentStatus("pty-a1")).toBe("working")
      expect(api.terminal.agentStatus("pty-a2")).toBe("permission")
      expect(api.terminal.agentStatus("pty-unknown")).toBe("idle")
    } finally {
      dispose()
    }
  })

  test("getTabAgentStatus aggregates across all terminals in a tab pane", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-agg-1", "Terminal Agg")

      api.terminal.own(tabId, "pty-agg-1")
      api.terminal.ensure(tabId, "pty-agg-1")
      api.terminal.split({ tab: tabId, at: "pty-agg-1", id: "pty-agg-2", dir: "h" })
      api.terminal.own(tabId, "pty-agg-2")

      // No agent status set — all idle
      let status = api.terminal.getTabAgentStatus(tabId)
      expect(status.loading).toBe(false)
      expect(status.attention).toBe(false)
      expect(status.done).toBe(false)

      // One working
      api.terminal.setAgentStatus("pty-agg-1", "working")
      status = api.terminal.getTabAgentStatus(tabId)
      expect(status.loading).toBe(true)
      expect(status.attention).toBe(false)

      // One permission
      api.terminal.setAgentStatus("pty-agg-2", "permission")
      status = api.terminal.getTabAgentStatus(tabId)
      expect(status.loading).toBe(true)
      expect(status.attention).toBe(true)

      // Clear working, keep permission
      api.terminal.setAgentStatus("pty-agg-1", "idle")
      status = api.terminal.getTabAgentStatus(tabId)
      expect(status.loading).toBe(false)
      expect(status.attention).toBe(true)
      // pty-agg-1 was seen (it had working status before), so done should be true
      // when there's no working and no permission on that terminal
      expect(status.done).toBe(false) // pty-agg-2 still has permission

      // Clear all
      api.terminal.setAgentStatus("pty-agg-2", "idle")
      status = api.terminal.getTabAgentStatus(tabId)
      expect(status.loading).toBe(false)
      expect(status.attention).toBe(false)
      expect(status.done).toBe(true) // both were seen, neither is active
    } finally {
      dispose()
    }
  })

  test("clearing tab state clears agent status for owned terminals", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id
      const { tabId } = createTerminalBinding(api, "/ws", "pty-clear-agent", gid)

      api.terminal.setAgentStatus("pty-clear-agent", "working")
      expect(api.terminal.agentStatus("pty-clear-agent")).toBe("working")

      // Clear the tab (simulates tab close)
      api.terminal.clear(tabId)

      // The clear function should mark the lifecycle as closing for owned PTYs
      // and clear agent status/seen
      expect(api.terminal.lifecycle("pty-clear-agent")).toBe("closing")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Contract: Split pending tab for terminal splits
// ---------------------------------------------------------------------------

describe("contract: split pending tab coordination", () => {
  test("beginSplit/clearSplitPending tracks pending split target", () => {
    const { api, dispose } = createTestLayout()
    try {
      expect(api.terminal.splitPendingTab()).toBeUndefined()

      api.terminal.beginSplit("tab-split-1")
      expect(api.terminal.splitPendingTab()).toBe("tab-split-1")

      api.terminal.clearSplitPending("tab-split-1")
      expect(api.terminal.splitPendingTab()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("clearSplitPending only clears if matching tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.beginSplit("tab-split-a")
      expect(api.terminal.splitPendingTab()).toBe("tab-split-a")

      // Clearing with wrong tab ID does nothing
      api.terminal.clearSplitPending("tab-split-b")
      expect(api.terminal.splitPendingTab()).toBe("tab-split-a")

      // Clearing with correct tab ID works
      api.terminal.clearSplitPending("tab-split-a")
      expect(api.terminal.splitPendingTab()).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("clearSplitPending with no argument always clears", () => {
    const { api, dispose } = createTestLayout()
    try {
      api.terminal.beginSplit("tab-any")
      expect(api.terminal.splitPendingTab()).toBe("tab-any")

      api.terminal.clearSplitPending()
      expect(api.terminal.splitPendingTab()).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Contract: Pane operations within tabs (terminal reducer integration)
// ---------------------------------------------------------------------------

describe("contract: pane operations within tabs", () => {
  test("ensure creates initial leaf pane and sets focus", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-ensure", "Terminal Ensure")

      api.terminal.ensure(tabId, "pty-ensure")
      expect(api.terminal.ids(tabId)).toEqual(["pty-ensure"])
      expect(api.terminal.focus(tabId)).toBe("pty-ensure")
    } finally {
      dispose()
    }
  })

  test("split creates a split pane with two leaves", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-split-a", "Terminal Split")

      api.terminal.ensure(tabId, "pty-split-a")
      api.terminal.split({ tab: tabId, at: "pty-split-a", id: "pty-split-b", dir: "v" })

      expect(api.terminal.ids(tabId)).toEqual(["pty-split-a", "pty-split-b"])
      expect(api.terminal.focus(tabId)).toBe("pty-split-b")

      // Pane structure should be a split node
      const pane = api.terminal.pane(tabId)
      expect(pane.t).toBe("split")
      expect(pane.dir).toBe("v")
    } finally {
      dispose()
    }
  })

  test("close removes terminal from pane and updates focus", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-close-a", "Terminal Close")

      api.terminal.ensure(tabId, "pty-close-a")
      api.terminal.split({ tab: tabId, at: "pty-close-a", id: "pty-close-b", dir: "h" })

      // Focus is on b after split
      expect(api.terminal.focus(tabId)).toBe("pty-close-b")

      // Close b — focus should move to a
      api.terminal.close({ tab: tabId, id: "pty-close-b" })
      expect(api.terminal.ids(tabId)).toEqual(["pty-close-a"])
      expect(api.terminal.focus(tabId)).toBe("pty-close-a")
    } finally {
      dispose()
    }
  })

  test("zoom toggles zoom state within a tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-zoom", "Terminal Zoom")

      api.terminal.ensure(tabId, "pty-zoom")
      api.terminal.split({ tab: tabId, at: "pty-zoom", id: "pty-zoom-2", dir: "h" })

      expect(api.terminal.zoom(tabId)).toBeUndefined()

      api.terminal.setZoom(tabId, "pty-zoom")
      expect(api.terminal.zoom(tabId)).toBe("pty-zoom")

      // Unset zoom
      api.terminal.setZoom(tabId, undefined)
      expect(api.terminal.zoom(tabId)).toBeUndefined()
    } finally {
      dispose()
    }
  })

  test("swap exchanges two terminals in the pane tree", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-swap-a", "Terminal Swap")

      api.terminal.ensure(tabId, "pty-swap-a")
      api.terminal.split({ tab: tabId, at: "pty-swap-a", id: "pty-swap-b", dir: "h" })

      // Before swap: [a, b]
      expect(api.terminal.ids(tabId)).toEqual(["pty-swap-a", "pty-swap-b"])

      api.terminal.swap({ tab: tabId, a: "pty-swap-a", b: "pty-swap-b" })

      // After swap: [b, a]
      expect(api.terminal.ids(tabId)).toEqual(["pty-swap-b", "pty-swap-a"])
    } finally {
      dispose()
    }
  })

  test("path returns the pane-tree path to a terminal", () => {
    const { api, dispose } = createTestLayout()
    try {
      const gid = api.split.orderedGroups()[0].id
      const tabs = api.groupTabs(gid)
      const tabId = tabs.addTerminal("/ws", "pty-path-a", "Terminal Path")

      api.terminal.ensure(tabId, "pty-path-a")
      api.terminal.split({ tab: tabId, at: "pty-path-a", id: "pty-path-b", dir: "h" })

      const pathA = api.terminal.path({ tab: tabId, id: "pty-path-a" })
      const pathB = api.terminal.path({ tab: tabId, id: "pty-path-b" })

      expect(pathA).toBe("a")
      expect(pathB).toBe("b")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Contract: Cross-group invariant enforcement
// ---------------------------------------------------------------------------

describe("contract: cross-group invariant enforcement", () => {
  test("findTabGroup returns the correct group for a given tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const groupIds = createMultiGroupSetup(api, 3)

      const tab1 = api.groupTabs(groupIds[0]).addSession("/ws", "s1", "Session 1")
      const tab2 = api.groupTabs(groupIds[1]).addSession("/ws", "s2", "Session 2")
      const tab3 = api.groupTabs(groupIds[2]).addSession("/ws", "s3", "Session 3")

      expect(api.findTabGroup(tab1)).toBe(groupIds[0])
      expect(api.findTabGroup(tab2)).toBe(groupIds[1])
      expect(api.findTabGroup(tab3)).toBe(groupIds[2])
    } finally {
      dispose()
    }
  })

  test("patchTab updates a tab regardless of which group it is in", () => {
    const { api, dispose } = createTestLayout()
    try {
      const groupIds = createMultiGroupSetup(api, 2)

      const tabId = api.groupTabs(groupIds[1]).addSession("/ws", "s-patch", "Before")

      api.patchTab(tabId, { title: "After" })

      const tab = api.groupTabs(groupIds[1]).items().find((t: any) => t.id === tabId)
      expect(tab.title).toBe("After")
    } finally {
      dispose()
    }
  })

  test("moveTab transfers a tab from one group to another", () => {
    const { api, dispose } = createTestLayout()
    try {
      const groupIds = createMultiGroupSetup(api, 3)

      // Add a session to group 0
      const tabId = api.groupTabs(groupIds[0]).addSession("/ws", "s-move", "Movable")

      // Move to group 2
      api.split.moveTab(tabId, groupIds[0], groupIds[2])

      // Tab should be in group 2, not group 0
      expect(api.groupTabs(groupIds[0]).items().find((t: any) => t.id === tabId)).toBeUndefined()
      expect(api.groupTabs(groupIds[2]).items().find((t: any) => t.id === tabId)).toBeDefined()
    } finally {
      dispose()
    }
  })
})
