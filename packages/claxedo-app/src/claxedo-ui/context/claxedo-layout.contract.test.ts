import { beforeAll, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { getInitLayout, getPersistTarget, ensureLayoutMocked } from "./_test-helper"
import { defaultGroupLayout, type TopTabsState } from "./claxedo-layout/types"

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

function emptyTabs(): TopTabsState {
  return {
    items: [],
    activeId: null,
    order: [],
    closedTabs: [],
  }
}

function getMigrate() {
  const target = getPersistTarget() as { migrate?: (value: unknown) => unknown } | undefined
  if (!target?.migrate) throw new Error("persist target migrate not captured")
  return target.migrate
}

describe("claxedo layout API contract", () => {
  test("exposes frozen surface methods", () => {
    const { api, dispose } = createTestLayout()
    try {
      expect(api.topTabs).toBeDefined()
      expect(typeof api.groupTabs).toBe("function")
      expect(typeof api.worktree.setDefault).toBe("function")
      expect(typeof api.groupWorktree).toBe("function")
      expect(typeof api.groupLayout).toBe("function")
      expect(typeof api.split.toggle).toBe("function")
      expect(api.select).toBeDefined()
      expect(typeof api.select.visibleGroups).toBe("function")
      expect(typeof api.select.visibleGroupTabs).toBe("function")
      expect(typeof api.select.groupActiveTab).toBe("function")
      expect(typeof api.select.activeRenderTarget).toBe("function")
      expect(typeof api.select.multiPaneLeafView).toBe("function")
      expect(typeof api.select.multiPaneSplitHandles).toBe("function")
      expect(typeof api.dispatch).toBe("function")
      expect(typeof api.patchTab).toBe("function")
      expect(typeof api.findTabGroup).toBe("function")
      expect(typeof api.workspaceRecency.getRecent).toBe("function")
      expect(typeof api.workspaceRecency.recordAccess).toBe("function")
      expect(typeof api.workspaceRecency.cleanup).toBe("function")

      expect(api.terminal).toBeDefined()
      expect(typeof api.terminal.requestCreate).toBe("function")
      expect(typeof api.terminal.splitInTab).toBe("function")
      expect(typeof api.terminal.closeInTab).toBe("function")
      expect(typeof api.terminal.transitionLifecycle).toBe("function")
      expect(typeof api.terminal.getTabAgentStatus).toBe("function")

      expect(typeof api.getWorktreeColor).toBe("function")
      expect(typeof api.getWorktreeName).toBe("function")
      expect(typeof api.getTabGroupInfo).toBe("function")
      expect(typeof api.canDragTabBetweenWorktrees).toBe("function")
      expect(typeof api.getActiveWorktreeColor).toBe("function")

      expect(api.constants).toEqual({
        RAIL_COLLAPSED_WIDTH: 0,
        RAIL_EXPANDED_WIDTH: 260,
        HOT_ZONE_WIDTH: 20,
      })
    } finally {
      dispose()
    }
  })
})

describe("claxedo layout migration regression", () => {
  test("migrates flat tabs/worktree into grouped split shape", () => {
    const { dispose } = createTestLayout()
    try {
      const migrate = getMigrate()
      const sessionTab = {
        id: "session-1",
        type: "session",
        directory: "/ws",
        title: "Session 1",
        sessionId: "s1",
        closable: true,
      }

      const migrated = migrate({
        tabs: {
          items: [sessionTab],
          activeId: "session-1",
          order: ["session-1"],
          closedTabs: [],
        },
        worktree: { default: "/ws", pinned: null },
      }) as {
        groups: Array<{ id: string; tabs: TopTabsState; worktree: unknown; layout: unknown }>
        split: { direction: string; sizes: number[]; focusedId: string }
      }

      expect(migrated.groups).toHaveLength(1)
      expect(migrated.groups[0].id).toBe("g-initial")
      expect(migrated.groups[0].tabs).toEqual({
        items: [sessionTab],
        activeId: "session-1",
        order: ["session-1"],
        closedTabs: [],
      })
      expect(migrated.groups[0].worktree).toEqual({ default: "/ws", pinned: null })
      expect(migrated.groups[0].layout).toEqual(defaultGroupLayout())
      expect(migrated.split).toEqual({ direction: "h", sizes: [1], focusedId: "g-initial" })
    } finally {
      dispose()
    }
  })

  test("recovers when groups array is empty", () => {
    const { dispose } = createTestLayout()
    try {
      const migrate = getMigrate()
      const migrated = migrate({ groups: [] }) as {
        groups: Array<{
          id: string
          tabs: TopTabsState
          worktree: { default: string | null; pinned: string | null }
          layout: unknown
        }>
        split: { direction: string; sizes: number[]; focusedId: string }
      }

      expect(migrated.groups).toHaveLength(1)
      expect(migrated.groups[0].id).toBe("g-default")
      expect(migrated.groups[0].tabs).toEqual({
        items: [],
        activeId: null,
        order: [],
        closedTabs: [],
      })
      expect(migrated.groups[0].worktree).toEqual({ default: null, pinned: null })
      expect(migrated.groups[0].layout).toEqual(defaultGroupLayout())
      expect(migrated.split).toEqual({ direction: "h", sizes: [1], focusedId: "g-default" })
    } finally {
      dispose()
    }
  })

  test("backfills missing group layout", () => {
    const { dispose } = createTestLayout()
    try {
      const migrate = getMigrate()
      const migrated = migrate({
        groups: [
          {
            id: "g1",
            tabs: emptyTabs(),
            worktree: { default: null, pinned: null },
          },
        ],
      }) as {
        groups: Array<{ id: string; layout: unknown }>
      }

      expect(migrated.groups).toHaveLength(1)
      expect(migrated.groups[0].id).toBe("g1")
      expect(migrated.groups[0].layout).toEqual(defaultGroupLayout())
    } finally {
      dispose()
    }
  })

  test("strips legacy session/review/fileTree.tab fields from persisted layout", () => {
    const { dispose } = createTestLayout()
    try {
      const migrate = getMigrate()
      const migrated = migrate({
        groups: [
          {
            id: "g1",
            tabs: emptyTabs(),
            worktree: { default: null, pinned: null },
            layout: {
              fileTree: { opened: true, width: 320, tab: "changes" },
              session: { width: 500, collapsed: false, panelMode: 1 },
              reviewPanel: { opened: true },
            },
          },
        ],
      }) as {
        groups: Array<{
          id: string
          layout: Record<string, unknown>
        }>
      }

      expect(migrated.groups).toHaveLength(1)
      expect(migrated.groups[0].id).toBe("g1")
      // fileTree is no longer part of per-group layout
      expect(migrated.groups[0].layout).toEqual({})
    } finally {
      dispose()
    }
  })
})
