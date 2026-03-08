import { batch, createEffect, createMemo, createSignal, on, type Accessor } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import { createLayoutDispatcher } from "./commands"
import { createGroupAccessors } from "./groups"
import { createMultiPaneState, processSessionLayout, reviewSessionLayout } from "./multi-pane"
import { HOT_ZONE_WIDTH, RAIL_COLLAPSED_WIDTH, RAIL_EXPANDED_WIDTH, createRailState } from "./rail"
import { createLayoutSelectors } from "./selectors"
import { createSplitActions } from "./split"
import { createTabTypeRegistry } from "./tab-type-registry"
import { createTerminalState } from "./terminal"
import { createWorkspaceRecency } from "./workspace-recency"
import { type ClaxedoLayoutStore, type TabItem } from "./types"
import { createDebugLogger } from "../../../overrides/utils/debug"

const _suppressedAutoTab = new Set<string>()

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
  const debug = createDebugLogger("layout.process", "layout:process", {
    legacyKey: "opencode.debug.terminal",
  })
  const real = (dir?: string | null) => {
    if (!dir || dir === "__process__") return
    return dir
  }
  const snap = (groupId: string) => {
    const group = store.groups.find((g) => g.id === groupId)
    if (!group) return { found: false }
    return {
      found: true,
      activeId: group.tabs.activeId,
      defaultDir: group.worktree.default,
      pinnedDir: group.worktree.pinned,
      tabs: group.tabs.items.map((tab) => ({
        id: tab.id,
        type: tab.type,
        dir: tab.directory,
        active: tab.id === group.tabs.activeId,
      })),
    }
  }

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

  tabTypes.register("review-workspace", {
    onAdd: (tab) =>
      multiPaneState.initTab(
        tab.id,
        tab.directory,
        reviewSessionLayout({
          directory: tab.directory,
          sessionId: tab.sessionId ?? "new",
          reviewMode: tab.reviewMode,
          reviewFromRef: tab.reviewFromRef,
          reviewToRef: tab.reviewToRef,
        }),
      ),
    onClose: (tabId) => multiPaneState.clearTab(tabId),
    onMergeDrop: (tabId) => multiPaneState.clearTab(tabId),
    mergeDedupeKey: (tab) =>
      tab.sessionId
        ? [
            "review-workspace",
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
          filePath: tab.filePath,
          title: tab.title,
        })
        return
      }
      multiPaneState.initTabWithContent(tab.id, {
        type: "page",
        directory: tab.directory,
        pageId: tab.pageId,
        filePath: tab.filePath,
        title: tab.title,
      })
    },
    onClose: (tabId) => multiPaneState.clearTab(tabId),
    onMergeDrop: (tabId) => multiPaneState.clearTab(tabId),
  })

  tabTypes.register("process", {
    onAdd: (tab) =>
      multiPaneState.initTab(
        tab.id,
        tab.directory,
        processSessionLayout({ directory: tab.directory }),
      ),
    onClose: (tabId) => multiPaneState.clearTab(tabId),
    excludeFromMerge: true,
    mergeDedupeKey: (tab) => `process:${tab.directory}`,
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
    if (real(primary.worktree.default)) return primary.worktree.default
    if (!primary.tabs.activeId) return null
    const active = primary.tabs.items.find((t) => t.id === primary.tabs.activeId)
    // Skip process tab — it uses a synthetic "__process__" directory
    if (active?.type === "process") return null
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

  const resolve = (groupId: string, dir?: string) => {
    const group = store.groups.find((g) => g.id === groupId)
    if (!group) return
    const out =
      real(dir) ??
      real(group.worktree.pinned) ??
      real(group.worktree.default) ??
      real(group.tabs.items.find((tab) => tab.id === group.tabs.activeId && tab.type !== "process")?.directory) ??
      real(group.tabs.items.find((tab) => tab.type !== "process")?.directory)
    debug.verbose("resolve", {
      groupId,
      in: dir ?? null,
      out: out ?? null,
      ...snap(groupId),
    })
    return out
  }

  const repair = (groupId: string, dir?: string) => {
    const next = resolve(groupId, dir)
    if (!next) {
      debug.log("repair skipped", {
        groupId,
        in: dir ?? null,
        reason: "no-directory",
        ...snap(groupId),
      })
      return
    }
    const gi = store.groups.findIndex((g) => g.id === groupId)
    if (gi === -1) return

    const exact = store.groups[gi].tabs.items.find((tab) => tab.type === "process" && tab.directory === next)
    if (exact) {
      if (!real(store.groups[gi].worktree.default)) {
        setStore("groups", gi, "worktree", "default", next)
      }
      debug.verbose("repair exact", {
        groupId,
        dir: next,
        tabId: exact.id,
      })
      return exact
    }

    const tab = store.groups[gi].tabs.items.find((item) => item.type === "process" && !real(item.directory))
    if (!tab) {
      debug.log("repair skipped", {
        groupId,
        dir: next,
        reason: "no-stale-process-tab",
        ...snap(groupId),
      })
      return
    }

    batch(() => {
      if (!real(store.groups[gi].worktree.default)) {
        setStore("groups", gi, "worktree", "default", next)
      }
      setStore("groups", gi, "tabs", "items", (items) =>
        items.map((item) => (item.id === tab.id ? { ...item, directory: next } : item)),
      )
    })

    if (multiPaneState.getState(tab.id)) {
      for (const leafId of multiPaneState.leafIds(tab.id)) {
        const content = multiPaneState.getContent(tab.id, leafId)
        if (!content || content.type !== "process" || content.directory === next) continue
        multiPaneState.setContent(tab.id, leafId, {
          ...content,
          directory: next,
        })
      }
    }

    debug.log("repair applied", {
      groupId,
      from: tab.directory,
      to: next,
      tabId: tab.id,
      ...snap(groupId),
    })
    return { ...tab, directory: next }
  }

  // ── Ensure existing process tabs have multi-pane state ─────────────
  // Process tabs are only created via the "Processes" menu option.
  // This effect ensures persisted process tabs get their multi-pane state
  // initialized on reload (the onAdd hook doesn't fire for persisted tabs).
  createEffect(
    on(
      () =>
        store.groups.map((group) => ({
          id: group.id,
          defaultDirectory: group.worktree.default,
          pinnedDirectory: group.worktree.pinned,
          fallbackDirectory: group.tabs.items.find((tab) => tab.type !== "process")?.directory ?? null,
          processTabs: group.tabs.items
            .filter((tab) => tab.type === "process")
            .map((tab) => ({ id: tab.id, directory: tab.directory })),
        })),
      (groups) => {
        for (const group of groups) {
          const gi = store.groups.findIndex((g) => g.id === group.id)
          if (gi === -1) continue
          for (const processTab of group.processTabs) {
            const dir = real(processTab.directory) ?? resolve(group.id)
            if (!dir) continue

            batch(() => {
              if (!real(store.groups[gi].worktree.default)) {
                setStore("groups", gi, "worktree", "default", dir)
              }
            })

            if (processTab.directory !== dir) {
              setStore("groups", gi, "tabs", "items", (items) =>
                items.map((tab) => (tab.id === processTab.id ? { ...tab, directory: dir } : tab)),
              )
            }

            if (!multiPaneState.getState(processTab.id)) {
              multiPaneState.initTab(
                processTab.id,
                dir,
                processSessionLayout({ directory: dir }),
              )
              continue
            }

            for (const leafId of multiPaneState.leafIds(processTab.id)) {
              const content = multiPaneState.getContent(processTab.id, leafId)
              if (!content || content.type !== "process") continue
              if (content.directory === dir) continue
              multiPaneState.setContent(processTab.id, leafId, {
                ...content,
                directory: dir,
              })
            }
          }
        }
      },
    ),
  )

  const enabled = createMemo(() => store.enabled)
  const setEnabled = (value: boolean) => setStore("enabled", value)

  /** Find the process tab in the focused group. */
  const findProcessTab = (directory?: string, groupId?: string) => {
    const gid = groupId ?? store.split.focusedId ?? store.groups[0]?.id
    if (!gid) return undefined
    const group = store.groups.find((g) => g.id === gid)
    if (!group) return undefined
    const dir = resolve(gid, directory)
    if (!directory && !dir) {
      const tab = group.tabs.items.find((t) => t.type === "process" && !!real(t.directory))
      debug.log("find process tab", {
        gid,
        in: null,
        dir: null,
        tabId: tab?.id,
        reason: tab ? "real-process-fallback" : "no-real-process-tab",
        ...snap(gid),
      })
      return tab
    }
    if (!dir) return undefined
    const exact = group.tabs.items.find((t) => t.type === "process" && t.directory === dir)
    if (exact) {
      debug.verbose("find process tab", {
        gid,
        in: directory ?? null,
        dir,
        tabId: exact.id,
        reason: "exact",
      })
      return exact
    }
    const tab = repair(gid, dir)
    debug.log("find process tab", {
      gid,
      in: directory ?? null,
      dir,
      tabId: tab?.id,
      reason: tab ? "repaired" : "missing",
      ...snap(gid),
    })
    return tab
  }

  /** Check if the process tab for a directory is currently active in the focused group. */
  const isProcessTabActive = (directory?: string, groupId?: string) => {
    const gid = groupId ?? store.split.focusedId ?? store.groups[0]?.id
    if (!gid) return false
    const group = store.groups.find((g) => g.id === gid)
    if (!group) return false
    const processTab = findProcessTab(directory, gid)
    return !!processTab && group.tabs.activeId === processTab.id
  }

  // Transient signal — not persisted, set by ProcessPaneProvider effect
  const [processesRunning, setProcessesRunning] = createSignal<Record<string, boolean>>({})

  const running = (directory?: string | null) => {
    const dir = real(directory)
    if (!dir) return false
    return !!processesRunning()[dir]
  }

  function setRunning(directory: string | null | undefined, value: boolean) {
    const dir = real(directory)
    if (!dir) return
    setProcessesRunning((all) => {
      if (value) {
        if (all[dir]) return all
        return { ...all, [dir]: true }
      }
      if (!all[dir]) return all
      const next = { ...all }
      delete next[dir]
      return next
    })
  }

  const processPaneState = {
    /** Optional process pane target directory requested by top-bar workspace indicators. */
    targetDirectory: () => store.processPane.targetDirectory,
    /** Fire a toggle request: if process tab is active, switch back; otherwise activate it. */
    requestToggle(directory?: string) {
      const gid = store.split.focusedId ?? store.groups[0]?.id
      const dir = gid ? resolve(gid, directory) : real(directory)
      setStore("processPane", "targetDirectory", dir ?? null)
      debug.log("request toggle", {
        gid: gid ?? null,
        in: directory ?? null,
        dir: dir ?? null,
        target: store.processPane.targetDirectory ?? null,
      })
      if (!gid) return
      const gi = store.groups.findIndex((g) => g.id === gid)
      if (gi === -1) return
      const group = store.groups[gi]
      const processTab = directory ? (dir ? findProcessTab(dir, gid) : undefined) : findProcessTab(undefined, gid)
      if (!processTab) {
        debug.log("request toggle blocked", {
          gid,
          in: directory ?? null,
          dir: dir ?? null,
          reason: "no-process-tab",
          ...snap(gid),
        })
        return
      }

      if (group.tabs.activeId === processTab.id) {
        // Toggle off: switch to the most recent non-process tab
        const order = group.tabs.order.length ? group.tabs.order : group.tabs.items.map((t) => t.id)
        const prev = order.filter((id) => id !== processTab.id)
        const fallback = prev[prev.length - 1] ?? null
        setStore("groups", gi, "tabs", "activeId", fallback)
      } else {
        // Toggle on: activate the process tab
        setStore("groups", gi, "tabs", "activeId", processTab.id)
        setStore("processPane", "crashedWhileClosed", false)
      }
    },
    /** Request the process tab to be activated (no toggle-back). */
    requestOpen(directory?: string) {
      const gid = store.split.focusedId ?? store.groups[0]?.id
      const dir = gid ? resolve(gid, directory) : real(directory)
      setStore("processPane", "targetDirectory", dir ?? null)
      debug.log("request open", {
        gid: gid ?? null,
        in: directory ?? null,
        dir: dir ?? null,
        target: store.processPane.targetDirectory ?? null,
      })
      if (!gid) return
      const gi = store.groups.findIndex((g) => g.id === gid)
      if (gi === -1) return
      const processTab = directory ? (dir ? findProcessTab(dir, gid) : undefined) : findProcessTab(undefined, gid)
      if (!processTab) {
        debug.log("request open blocked", {
          gid,
          in: directory ?? null,
          dir: dir ?? null,
          reason: "no-process-tab",
          ...snap(gid),
        })
        return
      }
      setStore("groups", gi, "tabs", "activeId", processTab.id)
      setStore("processPane", "crashedWhileClosed", false)
    },
    /** Set/clear the current process pane target directory without opening/toggling. */
    setTargetDirectory(directory: string | null) {
      setStore("processPane", "targetDirectory", real(directory) ?? null)
    },
    /** True when a process crashed while the process tab is not active — drives workspace dot alert ring. */
    crashedWhileClosed: () => store.processPane.crashedWhileClosed,
    /** Set the crashedWhileClosed flag (called by ProcessPaneProvider on crash SSE). */
    setCrashedWhileClosed(value: boolean) {
      setStore("processPane", "crashedWhileClosed", value)
    },
    /** True when any configured process is running/starting/restarting in the given workspace. */
    running,
    /** Set by ProcessPaneProvider to sync hasRunning() into the facade for one workspace. */
    setRunning,
    /** Check if the process tab is the active tab in the focused group. */
    isActive: isProcessTabActive,
    /** Find the process tab in the focused group. */
    findProcessTab,
    /** Request Start All action (consumed by ProcessPaneProvider). */
    requestStartAll() {
      setStore("processPane", "pendingAction", "startAll")
    },
    /** Request Stop All action (consumed by ProcessPaneProvider). */
    requestStopAll() {
      setStore("processPane", "pendingAction", "stopAll")
    },
    /** Request Add Process action (consumed by ProcessPaneProvider). */
    requestAddProcess() {
      setStore("processPane", "pendingAction", "add")
    },
    /** Read the pending action. */
    pendingAction: () => store.processPane.pendingAction,
    /** Clear the pending action after consumption. */
    clearPendingAction() {
      setStore("processPane", "pendingAction", null)
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
      addReviewWorkspace(
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
            type: "ReviewWorkspaceTabAddRequested",
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
      addPage(pageId: string, title: string, directory?: string, filePath?: string) {
        return asTabId(dispatch({ type: "PageTabAddRequested", groupId, pageId, title, directory, filePath }))
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
    addReviewWorkspace(
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
          type: "ReviewWorkspaceTabAddRequested",
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
    addPage(pageId: string, title: string, directory?: string, filePath?: string) {
      const groupId = activeGroupId()
      if (!groupId) return ""
      return asTabId(dispatch({ type: "PageTabAddRequested", groupId, pageId, title, directory, filePath }))
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
    requestStartAll() {
      processPaneState.requestStartAll()
    },
    requestStopAll() {
      processPaneState.requestStopAll()
    },
    requestAddProcess() {
      processPaneState.requestAddProcess()
    },
    pendingAction: processPaneState.pendingAction,
    clearPendingAction() {
      processPaneState.clearPendingAction()
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
    float(tabId: string, leafId: string) {
      dispatch({ type: "PaneFloatRequested", tabId, leafId })
    },
    unfloat(tabId: string) {
      dispatch({ type: "PaneUnfloatRequested", tabId })
    },
    toggleFileTree(tabId: string, directory: string) {
      dispatch({ type: "FileTreePaneToggleRequested", tabId, directory })
    },
    hasFileTree(tabId: string) {
      return multiPaneState.hasFileTree(tabId)
    },
    toggleReviewWorkspace(
      tabId: string,
      directory: string,
      sessionId?: string,
      reviewMode?: import("./types").ReviewMode,
    ) {
      multiPaneState.toggleReviewWorkspace(tabId, directory, sessionId, reviewMode)
    },
    hasReviewWorkspace(tabId: string) {
      return multiPaneState.hasReviewWorkspace(tabId)
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

    suppressAutoTab(dir: string) { _suppressedAutoTab.add(dir) },
    allowAutoTab(dir: string) { _suppressedAutoTab.delete(dir) },
    isAutoTabSuppressed(dir: string) { return _suppressedAutoTab.has(dir) },

    constants: {
      RAIL_COLLAPSED_WIDTH,
      RAIL_EXPANDED_WIDTH,
      HOT_ZONE_WIDTH,
    },
  }
}
