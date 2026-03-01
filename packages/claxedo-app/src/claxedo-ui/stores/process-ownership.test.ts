/**
 * Process Ownership Adapter Tests
 *
 * Tests the ClaxedoLayout adapter for process ownership + terminal tab ops.
 */
import { describe, expect, test } from "bun:test"
import {
  createProcessOwnership,
  createTerminalTabOps,
} from "./process-ownership"

// ── Mock infrastructure ──────────────────────────────────────────────

function createMockClaxedoFacade() {
  const ownedPtys = new Map<string, string>()
  let pendingProcessPtys = 1
  const groups: Array<{
    id: string
    tabs: Array<{ id: string; type: string; terminalId?: string }>
  }> = []
  const closedTabs: string[] = []
  const addedTerminals: Array<{ dir: string; ptyId: string; title: string }> = []
  let activeTabId: string | null = null

  return {
    facade: {
      terminal: {
        own(tab: string, id: string) {
          ownedPtys.set(id, tab)
        },
        disown(id: string) {
          ownedPtys.delete(id)
        },
        owner(id: string) {
          return ownedPtys.get(id)
        },
        processOwnedPtyIds() {
          const result: string[] = []
          for (const [ptyId, owner] of ownedPtys) {
            if (owner.startsWith("process:")) result.push(ptyId)
          }
          return result
        },
        expectProcessPty() {
          pendingProcessPtys++
        },
        resolveProcessPty() {
          pendingProcessPtys = Math.max(0, pendingProcessPtys - 1)
        },
        resolveInitialProcessPty() {
          pendingProcessPtys = Math.max(0, pendingProcessPtys - 1)
        },
      },
      split: {
        orderedGroups: () => groups,
        focusedId: () => undefined as string | undefined,
      },
      groupTabs: (groupId: string) => ({
        items: () => groups.find((g) => g.id === groupId)?.tabs ?? [],
        close(tabId: string) {
          closedTabs.push(tabId)
          const group = groups.find((g) => g.id === groupId)
          if (group) {
            group.tabs = group.tabs.filter((t) => t.id !== tabId)
          }
        },
        addTerminal(dir: string, ptyId: string, title: string) {
          addedTerminals.push({ dir, ptyId, title })
          return `tab-${ptyId}`
        },
        setActive(id: string) {
          activeTabId = id
        },
      }),
      topTabs: {
        addTerminal(dir: string, ptyId: string, title: string) {
          addedTerminals.push({ dir, ptyId, title })
          return `tab-${ptyId}`
        },
        setActive(id: string) {
          activeTabId = id
        },
      },
    },
    _ownedPtys: ownedPtys,
    _pending: () => pendingProcessPtys,
    _groups: groups,
    _closedTabs: closedTabs,
    _addedTerminals: addedTerminals,
    _activeTab: () => activeTabId,
    _setGroups(g: typeof groups) {
      groups.length = 0
      groups.push(...g)
    },
  }
}

// ── ClaxedoLayout adapter tests ──────────────────────────────────────

describe("createProcessOwnership (ClaxedoLayout adapter)", () => {
  test("ownProcess delegates to claxedo.terminal.own with process: prefix", () => {
    const mock = createMockClaxedoFacade()
    const ownership = createProcessOwnership(mock.facade)

    ownership.ownProcess("my-config", "pty-1")
    expect(mock._ownedPtys.get("pty-1")).toBe("process:my-config")
  })

  test("disownProcess delegates to claxedo.terminal.disown", () => {
    const mock = createMockClaxedoFacade()
    const ownership = createProcessOwnership(mock.facade)

    ownership.ownProcess("my-config", "pty-1")
    expect(mock._ownedPtys.has("pty-1")).toBe(true)

    ownership.disownProcess("pty-1")
    expect(mock._ownedPtys.has("pty-1")).toBe(false)
  })

  test("ownerOf delegates to claxedo.terminal.owner", () => {
    const mock = createMockClaxedoFacade()
    const ownership = createProcessOwnership(mock.facade)

    expect(ownership.ownerOf("pty-1")).toBeUndefined()

    ownership.ownProcess("my-config", "pty-1")
    expect(ownership.ownerOf("pty-1")).toBe("process:my-config")
  })

  test("processOwnedPtyIds returns only process-owned PTYs", () => {
    const mock = createMockClaxedoFacade()
    const ownership = createProcessOwnership(mock.facade)

    ownership.ownProcess("c1", "pty-1")
    ownership.ownProcess("c2", "pty-2")
    // Manually add a tab-owned PTY
    mock._ownedPtys.set("pty-3", "tab-123")

    const ids = ownership.processOwnedPtyIds()
    expect(ids).toContain("pty-1")
    expect(ids).toContain("pty-2")
    expect(ids).not.toContain("pty-3")
  })

  test("expectProcessPty / resolveProcessPty manage pending count", () => {
    const mock = createMockClaxedoFacade()
    const ownership = createProcessOwnership(mock.facade)
    const before = mock._pending()

    ownership.expectProcessPty()
    expect(mock._pending()).toBe(before + 1)

    ownership.resolveProcessPty()
    expect(mock._pending()).toBe(before)
  })

  test("resolveInitialProcessPty decrements pending count", () => {
    const mock = createMockClaxedoFacade()
    const ownership = createProcessOwnership(mock.facade)
    const before = mock._pending()

    ownership.resolveInitialProcessPty()
    expect(mock._pending()).toBe(before - 1)
  })
})

// ── TerminalTabOps tests ──────────────────────────────────────────────

describe("createTerminalTabOps", () => {
  test("removeAutoCreatedTab closes matching terminal tab", () => {
    const mock = createMockClaxedoFacade()
    mock._setGroups([
      { id: "g1", tabs: [{ id: "tab-1", type: "terminal", terminalId: "pty-1" }] },
    ])
    const tabOps = createTerminalTabOps(mock.facade)

    tabOps.removeAutoCreatedTab("pty-1")
    expect(mock._closedTabs).toContain("tab-1")
  })

  test("removeTerminalTabsByPtyIds closes matching tabs across groups", () => {
    const mock = createMockClaxedoFacade()
    mock._setGroups([
      { id: "g1", tabs: [
        { id: "tab-1", type: "terminal", terminalId: "pty-1" },
        { id: "tab-2", type: "session" },
      ]},
      { id: "g2", tabs: [
        { id: "tab-3", type: "terminal", terminalId: "pty-2" },
      ]},
    ])
    const tabOps = createTerminalTabOps(mock.facade)

    tabOps.removeTerminalTabsByPtyIds(new Set(["pty-1", "pty-2"]))
    expect(mock._closedTabs).toContain("tab-1")
    expect(mock._closedTabs).toContain("tab-3")
    expect(mock._closedTabs).not.toContain("tab-2")
  })

  test("removeTerminalTabsByPtyIds is a no-op for empty set", () => {
    const mock = createMockClaxedoFacade()
    mock._setGroups([
      { id: "g1", tabs: [{ id: "tab-1", type: "terminal", terminalId: "pty-1" }] },
    ])
    const tabOps = createTerminalTabOps(mock.facade)

    tabOps.removeTerminalTabsByPtyIds(new Set())
    expect(mock._closedTabs).toHaveLength(0)
  })

  test("addTerminalTab delegates to topTabs when no focused group", () => {
    const mock = createMockClaxedoFacade()
    const tabOps = createTerminalTabOps(mock.facade)

    const tabId = tabOps.addTerminalTab("/test", "pty-1", "My Terminal")
    expect(tabId).toBe("tab-pty-1")
    expect(mock._addedTerminals).toEqual([{ dir: "/test", ptyId: "pty-1", title: "My Terminal" }])
  })

  test("setActiveTab delegates to topTabs when no focused group", () => {
    const mock = createMockClaxedoFacade()
    const tabOps = createTerminalTabOps(mock.facade)

    tabOps.setActiveTab("tab-1")
    expect(mock._activeTab()).toBe("tab-1")
  })
})
