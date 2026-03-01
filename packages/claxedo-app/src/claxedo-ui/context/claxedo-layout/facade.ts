import { batch, createMemo, type Accessor } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import { createLayoutDispatcher } from "./commands"
import { createGroupAccessors } from "./groups"
import { createMultiPaneState } from "./multi-pane"
import { HOT_ZONE_WIDTH, RAIL_COLLAPSED_WIDTH, RAIL_EXPANDED_WIDTH, createRailState } from "./rail"
import { createLayoutSelectors } from "./selectors"
import { createSplitActions } from "./split"
import { createTabTypeRegistry } from "./tab-type-registry"
import { createTerminalState } from "./terminal"
import { createWorkspaceRecency } from "./workspace-recency"
import type { ClaxedoLayoutStore, TabItem } from "./types"

const WORKTREE_COLORS = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#a855f7", // purple
  "#f97316", // orange
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f59e0b", // amber
  "#6366f1", // indigo
  "#ef4444", // red
  "#06b6d4", // cyan
]

export function createClaxedoLayoutFacade(input: {
  store: ClaxedoLayoutStore
  setStore: SetStoreFunction<ClaxedoLayoutStore>
  ready: Accessor<boolean>
}) {
  const { store, setStore, ready } = input

  const focusedGroup = () => {
    const id = store.split.focusedId
    return store.groups.find((g) => g.id === id) ?? store.groups[0]
  }

  const rail = createRailState({ store, setStore })

  const findTabGroup = (tabId: string): string | undefined => {
    return store.groups.find((g) => g.tabs.items.some((t) => t.id === tabId))?.id
  }

  const patchTab = (tabId: string, patch: Partial<TabItem>) => {
    for (let i = 0; i < store.groups.length; i++) {
      if (store.groups[i].tabs.items.some((t) => t.id === tabId)) {
        setStore("groups", i, "tabs", "items", (items: TabItem[]) =>
          (items ?? []).map((t) => (t.id !== tabId ? t : { ...t, ...patch })),
        )
        return
      }
    }
  }

  const multiPaneState = createMultiPaneState({ store, setStore })

  const terminalState = createTerminalState({
    store,
    setStore,
    findTabGroup,
    multiPane: multiPaneState,
  })

  const tabTypes = createTabTypeRegistry()

  tabTypes.register("terminal", {
    onAdd: (tab) =>
      multiPaneState.initTabWithContent(tab.id, {
        type: "terminal",
        directory: tab.directory,
        terminalId: tab.terminalId,
        title: tab.title,
      }),
    onClose: (tabId) => {
      terminalState.clearTerminalTabState(tabId)
      multiPaneState.clearTab(tabId)
    },
    onReopen: (tab, helper) => {
      const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      const reopened = helper.addTerminal(tab.directory, pendingId, tab.title || "Terminal")
      if (!reopened) return false
      terminalState.terminal.queueCreateForTab(
        reopened,
        tab.directory,
        undefined,
        tab.title,
        helper.groupId,
        tab.terminalId,
      )
      return true
    },
    excludeFromMerge: true,
    mergeDedupeKey: (tab) => (tab.terminalId ? `terminal:${tab.terminalId}:${tab.directory}` : undefined),
    onMergeDrop: (tabId) => {
      terminalState.clearTerminalTabState(tabId)
      multiPaneState.clearTab(tabId)
    },
  })

  tabTypes.register("multi-pane", {
    onClose: (tabId) => multiPaneState.clearTab(tabId),
    onAdd: (tab) => multiPaneState.initTab(tab.id, tab.directory),
  })

  tabTypes.register("session", {
    onAdd: (tab) =>
      multiPaneState.initTabWithContent(tab.id, {
        type: "session",
        directory: tab.directory,
        sessionId: tab.sessionId,
        title: tab.title,
      }),
    onClose: (tabId) => multiPaneState.clearTab(tabId),
    onMergeDrop: (tabId) => multiPaneState.clearTab(tabId),
    mergeDedupeKey: (tab) => (tab.sessionId ? `session:${tab.sessionId}:${tab.directory}` : undefined),
  })

  tabTypes.register("review", {
    onAdd: (tab) =>
      multiPaneState.initTabWithContent(tab.id, {
        type: "review",
        directory: tab.directory,
        sessionId: tab.sessionId,
        title: tab.title,
        reviewMode: tab.reviewMode,
        reviewFromRef: tab.reviewFromRef,
        reviewToRef: tab.reviewToRef,
      }),
    onClose: (tabId) => multiPaneState.clearTab(tabId),
    onMergeDrop: (tabId) => multiPaneState.clearTab(tabId),
    mergeDedupeKey: (tab) =>
      tab.sessionId
        ? [
            "review",
            tab.sessionId,
            tab.directory,
            tab.reviewMode ?? "session",
            tab.reviewFromRef ?? "",
            tab.reviewToRef ?? "",
          ].join(":")
        : undefined,
  })

  tabTypes.register("context", {
    onAdd: (tab) =>
      multiPaneState.initTabWithContent(tab.id, {
        type: "context",
        directory: tab.directory,
        sessionId: tab.sessionId,
        title: tab.title,
      }),
    onClose: (tabId) => multiPaneState.clearTab(tabId),
    onMergeDrop: (tabId) => multiPaneState.clearTab(tabId),
    mergeDedupeKey: (tab) => (tab.sessionId ? `context:${tab.sessionId}:${tab.directory}` : undefined),
  })

  tabTypes.register("file", {
    onAdd: (tab) =>
      multiPaneState.initTabWithContent(tab.id, {
        type: "file",
        directory: tab.directory,
        filePath: tab.filePath,
        title: tab.title,
      }),
    onClose: (tabId) => multiPaneState.clearTab(tabId),
    onMergeDrop: (tabId) => multiPaneState.clearTab(tabId),
  })

  tabTypes.register("page", {
    onAdd: (tab) => {
      if (tab.pageId && tab.directory && tab.directory !== "__pages__") {
        multiPaneState.initPageSessionTab(tab.id, {
          directory: tab.directory,
          pageId: tab.pageId,
          title: tab.title,
        })
        return
      }
      multiPaneState.initTabWithContent(tab.id, {
        type: "page",
        directory: tab.directory,
        pageId: tab.pageId,
        title: tab.title,
      })
    },
    onClose: (tabId) => multiPaneState.clearTab(tabId),
    onMergeDrop: (tabId) => multiPaneState.clearTab(tabId),
  })

  const {
    groupTabs: groupTabsState,
    groupWorktree: groupWorktreeState,
    groupLayout,
    topTabs: topTabsState,
    worktree: worktreeState,
  } = createGroupAccessors({
    store,
    setStore,
    focusedGroup,
    getTabHooks: tabTypes.get,
  })

  const defaultForNewGroup = () => {
    const primary = store.groups[0]
    if (!primary) return null
    if (primary.worktree.default) return primary.worktree.default
    if (!primary.tabs.activeId) return null
    const active = primary.tabs.items.find((t) => t.id === primary.tabs.activeId)
    return active?.directory ?? null
  }

  const splitState = createSplitActions({
    store,
    setStore,
    clearStaleCreatingState: terminalState.clearStaleCreatingState,
    defaultForNewGroup,
    getTabHooks: tabTypes.get,
  })

  const workspaceRecency = createWorkspaceRecency({
    store,
    setStore,
  })

  const enabled = createMemo(() => store.enabled)
  const setEnabled = (value: boolean) => setStore("enabled", value)

  const processPaneState = {
    /** Monotonically increasing counter — watch with `on(..., { defer: true })` to react to toggle requests. */
    toggleVersion: () => store.processPane.toggleVersion,
    /** Optional process pane target directory requested by top-bar workspace indicators. */
    targetDirectory: () => store.processPane.targetDirectory,
    /** Fire a toggle request (from keyboard shortcut or other global UI). */
    requestToggle(directory?: string) {
      setStore("processPane", "targetDirectory", directory ?? null)
      setStore("processPane", "toggleVersion", (v) => (v ?? 0) + 1)
    },
    /** Request the pane to open on next ProcessPaneProvider mount (workspace switch). */
    requestOpen(directory?: string) {
      setStore("processPane", "targetDirectory", directory ?? null)
      setStore("processPane", "pendingOpen", true)
    },
    /** Set/clear the current process pane target directory without opening/toggling. */
    setTargetDirectory(directory: string | null) {
      setStore("processPane", "targetDirectory", directory)
    },
    /** Consume the pendingOpen flag (called by ProcessPaneProvider on mount). */
    consumePendingOpen(): boolean {
      const pending = store.processPane.pendingOpen
      if (pending) setStore("processPane", "pendingOpen", false)
      return pending
    },
    /** True when a process crashed while the pane was closed — drives workspace dot alert ring. */
    crashedWhileClosed: () => store.processPane.crashedWhileClosed,
    /** Set the crashedWhileClosed flag (called by ProcessPaneProvider on crash SSE). */
    setCrashedWhileClosed(value: boolean) {
      setStore("processPane", "crashedWhileClosed", value)
    },
  }

  const select = createLayoutSelectors({ store })

  const dispatch = createLayoutDispatcher({
    split: splitState,
    groupTabs: groupTabsState,
    groupWorktree: groupWorktreeState,
    multiPane: multiPaneState,
    processPane: processPaneState,
  })

  const activeGroupId = () => {
    const focusedId = store.split.focusedId
    if (focusedId && store.groups.some((group) => group.id === focusedId)) return focusedId
    return store.groups[0]?.id
  }

  const asTabId = (value: unknown) => (typeof value === "string" ? value : "")

  const groupTabs = (groupId: string) => {
    const tabs = groupTabsState(groupId)
    return {
      ...tabs,
      add(tab: Omit<TabItem, "id">) {
        return asTabId(dispatch({ type: "TabAddRequested", groupId, tab }))
      },
      addSession(directory: string, sessionId: string, title: string, badge?: TabItem["badge"]) {
        return asTabId(dispatch({ type: "SessionTabAddRequested", groupId, directory, sessionId, title, badge }))
      },
      addTerminal(directory: string, terminalId: string, title: string) {
        return asTabId(dispatch({ type: "TerminalTabAddRequested", groupId, directory, terminalId, title }))
      },
      addReview(
        directory: string,
        sessionId: string,
        title: string,
        badge?: TabItem["badge"],
        reviewMode?: TabItem["reviewMode"],
        reviewFromRef?: string,
        reviewToRef?: string,
      ) {
        return asTabId(
          dispatch({
            type: "ReviewTabAddRequested",
            groupId,
            directory,
            sessionId,
            title,
            badge,
            reviewMode,
            reviewFromRef,
            reviewToRef,
          }),
        )
      },
      addContext(directory: string, sessionId: string, title: string) {
        return asTabId(dispatch({ type: "ContextTabAddRequested", groupId, directory, sessionId, title }))
      },
      addFile(directory: string, filePath: string, title: string) {
        return asTabId(dispatch({ type: "FileTabAddRequested", groupId, directory, filePath, title }))
      },
      addPage(pageId: string, title: string, directory?: string) {
        return asTabId(dispatch({ type: "PageTabAddRequested", groupId, pageId, title, directory }))
      },
      patch(tabId: string, patch: Partial<TabItem>) {
        dispatch({ type: "TabPatchRequested", groupId, tabId, patch })
      },
      updateTitle(tabId: string, title: string) {
        dispatch({ type: "TabTitleUpdateRequested", groupId, tabId, title })
      },
      updateBadge(tabId: string, badge: TabItem["badge"]) {
        dispatch({ type: "TabBadgeUpdateRequested", groupId, tabId, badge })
      },
      setActive(tabId: string) {
        dispatch({ type: "TabActivateRequested", groupId, tabId })
      },
      activateByIndex(index: number) {
        dispatch({ type: "TabActivateByIndexRequested", groupId, index })
      },
      activateNext() {
        dispatch({ type: "TabActivateNextRequested", groupId })
      },
      activatePrevious() {
        dispatch({ type: "TabActivatePreviousRequested", groupId })
      },
      move(tabId: string, toIndex: number) {
        dispatch({ type: "TabMoveWithinGroupRequested", groupId, tabId, toIndex })
      },
      close(tabId: string) {
        dispatch({ type: "TabCloseRequested", groupId, tabId })
      },
      closeActive() {
        dispatch({ type: "TabCloseActiveRequested", groupId })
      },
      reopenLast() {
        dispatch({ type: "TabReopenLastRequested", groupId })
      },
    }
  }

  const groupWorktree = (groupId: string) => {
    const worktree = groupWorktreeState(groupId)
    return {
      ...worktree,
      setDefault(directory: string | null) {
        dispatch({ type: "GroupWorktreeDefaultSetRequested", groupId, directory })
      },
      setPinned(directory: string | null) {
        dispatch({ type: "GroupWorktreePinnedSetRequested", groupId, directory })
      },
    }
  }

  const topTabs = {
    ...topTabsState,
    add(tab: Omit<TabItem, "id">) {
      const groupId = activeGroupId()
      if (!groupId) return ""
      return asTabId(dispatch({ type: "TabAddRequested", groupId, tab }))
    },
    addSession(directory: string, sessionId: string, title: string, badge?: TabItem["badge"]) {
      const groupId = activeGroupId()
      if (!groupId) return ""
      return asTabId(dispatch({ type: "SessionTabAddRequested", groupId, directory, sessionId, title, badge }))
    },
    addTerminal(directory: string, terminalId: string, title: string) {
      const groupId = activeGroupId()
      if (!groupId) return ""
      return asTabId(dispatch({ type: "TerminalTabAddRequested", groupId, directory, terminalId, title }))
    },
    addReview(
      directory: string,
      sessionId: string,
      title: string,
      badge?: TabItem["badge"],
      reviewMode?: TabItem["reviewMode"],
      reviewFromRef?: string,
      reviewToRef?: string,
    ) {
      const groupId = activeGroupId()
      if (!groupId) return ""
      return asTabId(
        dispatch({
          type: "ReviewTabAddRequested",
          groupId,
          directory,
          sessionId,
          title,
          badge,
          reviewMode,
          reviewFromRef,
          reviewToRef,
        }),
      )
    },
    addContext(directory: string, sessionId: string, title: string) {
      const groupId = activeGroupId()
      if (!groupId) return ""
      return asTabId(dispatch({ type: "ContextTabAddRequested", groupId, directory, sessionId, title }))
    },
    addFile(directory: string, filePath: string, title: string) {
      const groupId = activeGroupId()
      if (!groupId) return ""
      return asTabId(dispatch({ type: "FileTabAddRequested", groupId, directory, filePath, title }))
    },
    addPage(pageId: string, title: string, directory?: string) {
      const groupId = activeGroupId()
      if (!groupId) return ""
      return asTabId(dispatch({ type: "PageTabAddRequested", groupId, pageId, title, directory }))
    },
    patch(tabId: string, patch: Partial<TabItem>) {
      const groupId = activeGroupId()
      if (!groupId) return
      dispatch({ type: "TabPatchRequested", groupId, tabId, patch })
    },
    updateTitle(tabId: string, title: string) {
      const groupId = activeGroupId()
      if (!groupId) return
      dispatch({ type: "TabTitleUpdateRequested", groupId, tabId, title })
    },
    updateBadge(tabId: string, badge: TabItem["badge"]) {
      const groupId = activeGroupId()
      if (!groupId) return
      dispatch({ type: "TabBadgeUpdateRequested", groupId, tabId, badge })
    },
    setActive(tabId: string) {
      const groupId = activeGroupId()
      if (!groupId) return
      dispatch({ type: "TabActivateRequested", groupId, tabId })
    },
    close(tabId: string) {
      const groupId = activeGroupId()
      if (!groupId) return
      dispatch({ type: "TabCloseRequested", groupId, tabId })
    },
    closeActive() {
      const groupId = activeGroupId()
      if (!groupId) return
      dispatch({ type: "TabCloseActiveRequested", groupId })
    },
    activateByIndex(index: number) {
      const groupId = activeGroupId()
      if (!groupId) return
      dispatch({ type: "TabActivateByIndexRequested", groupId, index })
    },
    activateNext() {
      const groupId = activeGroupId()
      if (!groupId) return
      dispatch({ type: "TabActivateNextRequested", groupId })
    },
    activatePrevious() {
      const groupId = activeGroupId()
      if (!groupId) return
      dispatch({ type: "TabActivatePreviousRequested", groupId })
    },
    move(tabId: string, toIndex: number) {
      const groupId = activeGroupId()
      if (!groupId) return
      dispatch({ type: "TabMoveWithinGroupRequested", groupId, tabId, toIndex })
    },
    reopenLast() {
      const groupId = activeGroupId()
      if (!groupId) return
      dispatch({ type: "TabReopenLastRequested", groupId })
    },
  }

  const worktree = {
    ...worktreeState,
    setDefault(directory: string | null) {
      const groupId = store.split.focusedId ?? store.groups[0]?.id
      if (!groupId) return
      dispatch({ type: "GroupWorktreeDefaultSetRequested", groupId, directory })
    },
    setPinned(directory: string | null) {
      const groupId = store.split.focusedId ?? store.groups[0]?.id
      if (!groupId) return
      dispatch({ type: "GroupWorktreePinnedSetRequested", groupId, directory })
    },
  }

  const processPane = {
    ...processPaneState,
    requestToggle(directory?: string) {
      dispatch({ type: "ProcessPaneToggleRequested", directory })
    },
    requestOpen(directory?: string) {
      dispatch({ type: "ProcessPaneOpenRequested", directory })
    },
    setTargetDirectory(directory: string | null) {
      dispatch({ type: "ProcessPaneTargetSetRequested", directory })
    },
    setCrashedWhileClosed(value: boolean) {
      dispatch({ type: "ProcessPaneCrashFlagSetRequested", value })
    },
  }

  const split = {
    ...splitState,
    setFocus(groupId: string) {
      dispatch({ type: "SplitFocusRequested", groupId })
    },
    setSizes(sizes: number[]) {
      dispatch({ type: "SplitSizesSetRequested", sizes })
    },
    toggle() {
      dispatch({ type: "SplitToggleRequested" })
    },
    closeGroup(groupId: string) {
      dispatch({ type: "SplitGroupCloseRequested", groupId })
    },
    moveTab(tabId: string, fromGroupId: string, toGroupId: string | "new") {
      dispatch({ type: "TabMoveAcrossGroupsRequested", tabId, fromGroupId, toGroupId })
    },
  }

  const multiPane = {
    ...multiPaneState,
    splitLeaf(
      tabId: string,
      dir: "h" | "v",
      atLeafId: string,
      content?: Parameters<typeof multiPaneState.splitLeaf>[3],
    ) {
      return dispatch({ type: "PaneSplitRequested", tabId, dir, leafId: atLeafId, content })
    },
    closeLeaf(tabId: string, leafId: string) {
      dispatch({ type: "PaneCloseRequested", tabId, leafId })
    },
    resize(tabId: string, path: string, size: number) {
      dispatch({ type: "PaneResizeRequested", tabId, path, size })
    },
    focus(tabId: string, leafId: string) {
      dispatch({ type: "PaneFocusRequested", tabId, leafId })
    },
    zoom(tabId: string, leafId: string) {
      dispatch({ type: "PaneZoomRequested", tabId, leafId })
    },
    setContent(tabId: string, leafId: string, content: Parameters<typeof multiPaneState.setContent>[2]) {
      dispatch({ type: "PaneContentSetRequested", tabId, leafId, content })
    },
  }

  return {
    ready,
    enabled,
    setEnabled,
    rail,
    topTabs,
    worktree,
    groupTabs,
    groupWorktree,
    groupLayout,
    split,
    select,
    dispatch,
    findTabGroup,
    patchTab,
    workspaceRecency,
    terminal: terminalState.terminal,
    multiPane,

    getWorktreeColor(directory: string): string {
      // Return persisted color if already assigned
      const existing = store.worktreeColorMap[directory]
      if (existing) return existing

      // Find colors already in use
      const usedColors = new Set(Object.values(store.worktreeColorMap))

      // Pick the first unused color; fall back to hash if all are taken
      let color = WORKTREE_COLORS.find((c) => !usedColors.has(c))
      if (!color) {
        let hash = 0
        for (let i = 0; i < directory.length; i++) {
          const char = directory.charCodeAt(i)
          hash = (hash << 5) - hash + char
          hash = hash & hash
        }
        color = WORKTREE_COLORS[Math.abs(hash) % WORKTREE_COLORS.length]
      }

      // Persist assignment
      setStore("worktreeColorMap", directory, color)
      return color
    },

    getWorktreeName(directory: string): string {
      const parts = directory.split("/")
      return parts[parts.length - 1] || parts[parts.length - 2] || "unknown"
    },

    getTabGroupInfo(
      groupId: string,
    ): Array<{ directory: string; color: string; tabs: Array<TabItem & { isLastInGroup: boolean }> }> {
      const group = store.groups.find((g) => g.id === groupId)
      if (!group) return []

      const byDirectory = new Map<string, TabItem[]>()
      for (const tab of group.tabs.items) {
        const existing = byDirectory.get(tab.directory) || []
        existing.push(tab)
        byDirectory.set(tab.directory, existing)
      }

      const getWorktreeColor = this.getWorktreeColor
      return Array.from(byDirectory.entries()).map(([directory, tabs]) => ({
        directory,
        color: getWorktreeColor(directory),
        tabs: tabs.map((tab, index) => ({
          ...tab,
          isLastInGroup: index === tabs.length - 1,
        })),
      }))
    },

    canDragTabBetweenWorktrees(fromDir: string, toDir: string): boolean {
      return fromDir === toDir
    },

    getActiveWorktreeColor(groupId: string): string | undefined {
      const wt = groupWorktree(groupId)
      const activeDir = wt.pinned() || wt.default()
      if (!activeDir) return undefined
      return this.getWorktreeColor(activeDir)
    },

    /** Remove all traces of a deleted worktree from the store. */
    cleanupDeletedWorktree(directory: string, projectId?: string) {
      batch(() => {
        for (let gi = 0; gi < store.groups.length; gi++) {
          const group = store.groups[gi]

          // Remove tabs from the deleted directory
          const remaining = group.tabs.items.filter((t) => t.directory !== directory)
          if (remaining.length !== group.tabs.items.length) {
            const removedIds = new Set(group.tabs.items.filter((t) => t.directory === directory).map((t) => t.id))
            const order = group.tabs.order.filter((id) => !removedIds.has(id))
            const closedTabs = group.tabs.closedTabs.filter((t) => t.directory !== directory)

            // Pick new active if current was removed
            let activeId = group.tabs.activeId
            if (activeId && removedIds.has(activeId)) {
              activeId = remaining.length > 0 ? remaining[0].id : null
            }

            setStore("groups", gi, "tabs", "items", remaining)
            setStore("groups", gi, "tabs", "order", order)
            setStore("groups", gi, "tabs", "closedTabs", closedTabs)
            setStore("groups", gi, "tabs", "activeId", activeId)
          }

          // Clear worktree default/pinned if they pointed to the deleted directory
          if (group.worktree.default === directory) {
            setStore("groups", gi, "worktree", "default", null)
          }
          if (group.worktree.pinned === directory) {
            setStore("groups", gi, "worktree", "pinned", null)
          }
        }

        // Clean up recency
        if (projectId) {
          const current = store.workspaceRecency[projectId] ?? []
          const cleaned = current.filter((dir) => dir !== directory)
          if (cleaned.length !== current.length) {
            setStore("workspaceRecency", projectId, cleaned)
          }
        }

        // Free the color assignment so it can be reused
        if (store.worktreeColorMap[directory]) {
          setStore("worktreeColorMap", directory, undefined!)
        }
      })
    },

    processPane,

    constants: {
      RAIL_COLLAPSED_WIDTH,
      RAIL_EXPANDED_WIDTH,
      HOT_ZONE_WIDTH,
    },
  }
}
