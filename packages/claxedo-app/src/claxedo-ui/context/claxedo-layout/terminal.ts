import { createSignal, untrack } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import { paneFindPath, paneList } from "../pane-reducer"
import { createDebugLogger } from "../../../overrides/utils/debug"
import type {
  ClaxedoLayoutStore,
  PaneContent,
  PaneDir,
  TabItem,
  TerminalActionOrigin,
  TerminalAgentStatus,
  TerminalLifecycleState,
} from "./types"
import type { createMultiPaneState } from "./multi-pane"

type TerminalInvariantPayload = {
  origin?: TerminalActionOrigin
  targetTab?: string
  expectedGroupId?: string
  terminalId?: string
  ownerTab?: string
  paneIds?: string[]
  reason?: string
}

type PendingTerminalCreate = {
  directory: string
  command?: string
  title?: string
  groupId?: string
  previousPtyId?: string
}

type PendingTabTerminalCreate = PendingTerminalCreate & {
  tabId: string
}

const requestDebug = createDebugLogger("terminal.layout", "terminal", {
  legacyKey: "opencode.debug.terminal",
})
const lifecycleDebug = createDebugLogger("terminal.lifecycle", "terminal:lifecycle", {
  legacyKey: "opencode.debug.terminal",
})

export function createTerminalState(input: {
  store: ClaxedoLayoutStore
  setStore: SetStoreFunction<ClaxedoLayoutStore>
  findTabGroup: (tabId: string) => string | undefined
  multiPane: ReturnType<typeof createMultiPaneState>
}) {
  const { store, setStore, findTabGroup, multiPane } = input

  const [pendingTerminalCreate, setPendingTerminalCreate] = createSignal(0)
  const [pendingTerminalCreates, setPendingTerminalCreates] = createSignal<PendingTerminalCreate[]>([])
  const [pendingTabTerminalCreates, setPendingTabTerminalCreates] = createSignal<
    Record<string, PendingTabTerminalCreate>
  >({})
  const [creatingTerminal, setCreatingTerminal] = createSignal(0)
  const [creatingTerminalGroupId, setCreatingTerminalGroupId] = createSignal<string | undefined>(undefined)
  const [splitPendingTab, setSplitPendingTab] = createSignal<string | undefined>(undefined)
  const [closingTerminalIds, setClosingTerminalIds] = createSignal<string[]>([])
  // Start at 1: assume processes may exist until ProcessPaneProvider resolves.
  // Without this, the detection effect creates tabs for process PTYs that arrive
  // via SSE before ProcessPaneProvider mounts (it sits in a <Show> conditional
  // that can resolve after the first SSE batch).
  const [pendingProcessStarts, setPendingProcessStarts] = createSignal(1)
  // Safety valve: if ProcessPaneProvider never mounts (no workspace with
  // processes.jsonc), auto-resolve after 15s so terminals aren't blocked forever.
  setTimeout(() => {
    setPendingProcessStarts((n) => (n === 1 ? 0 : n))
  }, 15_000)

  const firstPendingTerminalCreate = () => pendingTerminalCreates()[0]
  const pendingTerminalCommand = () => firstPendingTerminalCreate()?.command
  const pendingTerminalTitle = () => firstPendingTerminalCreate()?.title
  const pendingTerminalDir = () => firstPendingTerminalCreate()?.directory
  const pendingTerminalGroupId = () => firstPendingTerminalCreate()?.groupId

  const requestTerminalCreate = (
    dir: string,
    command?: string,
    title?: string,
    groupId?: string,
    previousPtyId?: string,
  ) => {
    requestDebug.log("claxedo requestCreate", { dir, command, title, groupId, previousPtyId })
    setPendingTerminalCreates((all) => {
      const next = [...all, { directory: dir, command, title, groupId, previousPtyId }]
      requestDebug.verbose("requestCreate queue update", {
        action: "enqueue",
        pendingCount: next.length,
        creating: creatingTerminal(),
        creatingGroupId: creatingTerminalGroupId(),
        queue: next.map((item) => ({
          directory: item.directory,
          groupId: item.groupId,
          hasCommand: !!item.command,
          hasTitle: !!item.title,
          previousPtyId: item.previousPtyId,
        })),
      })
      return next
    })
    setPendingTerminalCreate((n) => n + 1)
    setCreatingTerminal((n) => n + 1)
    setCreatingTerminalGroupId(groupId)

    setTimeout(() => {
      setCreatingTerminal((n) => Math.max(0, n - 1))
    }, 5000)
  }

  const clearPendingTerminalCreate = () => {
    const pendingCount = untrack(() => pendingTerminalCreates().length)
    const creating = untrack(() => creatingTerminal())
    const creatingGroupId = untrack(() => creatingTerminalGroupId())
    requestDebug.log("clearPendingCreate", {
      pendingCount,
      creating,
      creatingGroupId,
    })
    setPendingTerminalCreates([])
    setPendingTerminalCreate(0)
  }

  const queuePendingTerminalCreateForTab = (
    tabId: string,
    directory: string,
    command?: string,
    title?: string,
    groupId?: string,
    previousPtyId?: string,
  ) => {
    requestDebug.log("queueCreateForTab", { tabId, directory, command, title, groupId, previousPtyId })
    setPendingTabTerminalCreates((all) => ({
      ...all,
      [tabId]: { tabId, directory, command, title, groupId, previousPtyId },
    }))
  }

  const peekPendingTerminalCreateForTab = (tabId: string) => {
    return pendingTabTerminalCreates()[tabId]
  }

  const consumePendingTerminalCreateForTab = (tabId: string) => {
    const next = pendingTabTerminalCreates()[tabId]
    if (!next) return
    requestDebug.log("consumeCreateForTab", {
      tabId,
      directory: next.directory,
      command: next.command,
      title: next.title,
      groupId: next.groupId,
      previousPtyId: next.previousPtyId,
    })
    setPendingTabTerminalCreates((all) => {
      const copy = { ...all }
      delete copy[tabId]
      return copy
    })
    return next
  }

  const clearPendingTerminalCreateForTab = (tabId: string) => {
    setPendingTabTerminalCreates((all) => {
      if (!all[tabId]) return all
      const copy = { ...all }
      delete copy[tabId]
      return copy
    })
  }

  const consumePendingTerminalCommand = () => {
    const all = pendingTerminalCreates()
    const next = all[0]
    if (!next)
      return {
        directory: undefined,
        command: undefined,
        title: undefined,
        groupId: undefined,
        previousPtyId: undefined,
      }
    const rest = all.slice(1)
    const creating = untrack(() => creatingTerminal())
    const creatingGroupId = untrack(() => creatingTerminalGroupId())
    requestDebug.log("consumePendingCommand", {
      mode: "head",
      directory: next.directory,
      groupId: next.groupId,
      hasCommand: !!next.command,
      hasTitle: !!next.title,
      previousPtyId: next.previousPtyId,
      pendingBefore: all.length,
      pendingAfter: rest.length,
      creating,
      creatingGroupId,
    })
    setPendingTerminalCreates(rest)
    setPendingTerminalCreate(rest.length)
    setCreatingTerminalGroupId(next.groupId)
    return {
      directory: next.directory,
      command: next.command,
      title: next.title,
      groupId: next.groupId,
      previousPtyId: next.previousPtyId,
    }
  }

  const consumePendingTerminalCommandForDirectory = (directory: string) => {
    const all = pendingTerminalCreates()
    const index = all.findIndex((item) => item.directory === directory)
    if (index === -1) {
      requestDebug.verbose("consumePendingCommandForDirectory miss", {
        requestedDirectory: directory,
        pendingCount: all.length,
        queue: all.map((item) => ({ directory: item.directory, groupId: item.groupId })),
      })
      return {
        directory: undefined,
        command: undefined,
        title: undefined,
        groupId: undefined,
        previousPtyId: undefined,
      }
    }
    const next = all[index]
    const rest = [...all.slice(0, index), ...all.slice(index + 1)]
    const creating = untrack(() => creatingTerminal())
    const creatingGroupId = untrack(() => creatingTerminalGroupId())
    requestDebug.log("consumePendingCommandForDirectory", {
      requestedDirectory: directory,
      index,
      directory: next.directory,
      groupId: next.groupId,
      hasCommand: !!next.command,
      hasTitle: !!next.title,
      previousPtyId: next.previousPtyId,
      pendingBefore: all.length,
      pendingAfter: rest.length,
      creating,
      creatingGroupId,
    })
    setPendingTerminalCreates(rest)
    setPendingTerminalCreate(rest.length)
    setCreatingTerminalGroupId(next.groupId)
    return {
      directory: next.directory,
      command: next.command,
      title: next.title,
      groupId: next.groupId,
      previousPtyId: next.previousPtyId,
    }
  }

  const clearStaleCreatingState = (removedGroupIds: Set<string>) => {
    if (removedGroupIds.has(creatingTerminalGroupId() ?? "")) {
      setCreatingTerminal(0)
      setCreatingTerminalGroupId(undefined)
      setPendingTerminalCreates([])
      setPendingTerminalCreate(0)
    }
  }

  const findTab = (tabId: string): TabItem | undefined => {
    for (const group of store.groups) {
      const tab = group.tabs.items.find((item) => item.id === tabId)
      if (tab) return tab
    }
    return
  }

  const activeLayoutIndex = (tabId: string) => {
    const state = store.multiPane[tabId]
    if (!state) return -1
    const idx = state.layouts.findIndex((layout) => layout.id === state.activeLayoutId)
    return idx === -1 ? 0 : idx
  }

  const setLayoutFocus = (tabId: string, leafId: string | undefined) => {
    const idx = activeLayoutIndex(tabId)
    if (idx === -1) return
    if (store.multiPane[tabId]?.layouts[idx]?.focus === leafId) return
    setStore("multiPane", tabId, "layouts", idx, "focus", leafId)
  }

  const setLayoutZoom = (tabId: string, leafId: string | undefined) => {
    const idx = activeLayoutIndex(tabId)
    if (idx === -1) return
    if (store.multiPane[tabId]?.layouts[idx]?.zoom === leafId) return
    setStore("multiPane", tabId, "layouts", idx, "zoom", leafId)
  }

  const terminalLeaves = (tabId: string): Array<{ leafId: string; terminalId: string }> => {
    const layout = multiPane.activeLayout(tabId)
    if (!layout) return []
    return paneList(layout.pane).flatMap((leafId) => {
      const content = layout.contents[leafId]
      if (!content || content.type !== "terminal" || !content.terminalId) return []
      return [{ leafId, terminalId: content.terminalId }]
    })
  }

  const paneTerminalIds = (tabId: string) => terminalLeaves(tabId).map((item) => item.terminalId)

  const terminalIds = (tabId: string) => paneTerminalIds(tabId)

  const leafForTerminal = (tabId: string, terminalId: string): string | undefined => {
    const pair = terminalLeaves(tabId).find((item) => item.terminalId === terminalId)
    return pair?.leafId
  }

  const focusedTerminalId = (tabId: string): string | undefined => {
    const layout = multiPane.activeLayout(tabId)
    if (!layout) return
    if (layout.focus) {
      const content = layout.contents[layout.focus]
      if (content?.type === "terminal" && content.terminalId) return content.terminalId
    }
    return terminalLeaves(tabId)[0]?.terminalId
  }

  const zoomedTerminalId = (tabId: string): string | undefined => {
    const layout = multiPane.activeLayout(tabId)
    if (!layout?.zoom) return
    const content = layout.contents[layout.zoom]
    if (content?.type !== "terminal") return
    return content.terminalId
  }

  const ensurePaneTerminal = (tabId: string, terminalId: string) => {
    if (leafForTerminal(tabId, terminalId)) return
    if (multiPane.getState(tabId)) return
    const tab = findTab(tabId)
    multiPane.initTabWithContent(tabId, {
      type: "terminal",
      directory: tab?.directory ?? "",
      terminalId,
      title: tab?.title || "Terminal",
    })
  }

  const splitPaneTerminal = (tabId: string, atTerminalId: string, nextTerminalId: string, dir: PaneDir) => {
    ensurePaneTerminal(tabId, atTerminalId)
    const layout = multiPane.activeLayout(tabId)
    if (!layout) return
    const sourceLeafId = leafForTerminal(tabId, atTerminalId) ?? paneList(layout.pane)[0]
    if (!sourceLeafId) return
    const source = layout.contents[sourceLeafId]
    const directory = source?.directory || findTab(tabId)?.directory || ""
    const content: PaneContent = {
      type: "terminal",
      directory,
      terminalId: nextTerminalId,
      command: source?.command,
      title: source?.title || "Terminal",
    }
    multiPane.splitLeaf(tabId, dir, sourceLeafId, content)
  }

  const closePaneTerminal = (tabId: string, terminalId: string) => {
    const leafId = leafForTerminal(tabId, terminalId)
    if (!leafId) return
    const layout = multiPane.activeLayout(tabId)
    if (!layout) return
    if (paneList(layout.pane).length <= 1) {
      multiPane.clearTab(tabId)
      return
    }
    multiPane.closeLeaf(tabId, leafId)
  }

  const clearTerminalTabState = (tab: string) => {
    const linked = findTab(tab)?.terminalId
    const paneIds = linked ? [...terminalIds(tab), linked] : terminalIds(tab)
    const owned = Object.entries(store.terminalOwner)
      .filter(([, v]) => v === tab)
      .map(([k]) => k)
    const ids = [...new Set([...paneIds, ...owned])]

    setLayoutFocus(tab, undefined)
    setLayoutZoom(tab, undefined)

    for (const id of ids) {
      setStore("terminalOwner", id, undefined)
      setStore("terminalAgentStatus", id, undefined)
      setStore("terminalAgentSeen", id, undefined)
      setStore("terminalLifecycle", id, "closing")
    }
  }

  const terminalActionError = (action: string, payload: TerminalInvariantPayload) => {
    if (!import.meta.env.DEV) return
    // eslint-disable-next-line no-console
    console.error("[terminal:invariant]", {
      action,
      ...payload,
    })
  }

  const terminalLifecycleTransition = {
    creating: new Set<TerminalLifecycleState>(["attaching", "attached", "closing", "closed"]),
    attaching: new Set<TerminalLifecycleState>(["attached", "closing", "closed"]),
    attached: new Set<TerminalLifecycleState>(["closing", "closed"]),
    closing: new Set<TerminalLifecycleState>(["closed"]),
    closed: new Set<TerminalLifecycleState>(["creating", "attaching", "attached"]),
  } satisfies Record<TerminalLifecycleState, Set<TerminalLifecycleState>>

  const transitionTerminalLifecycle = (id: string, next: TerminalLifecycleState, reason?: string) => {
    const current = store.terminalLifecycle[id]
    if (current === next) return true
    const allowed =
      current === undefined
        ? new Set<TerminalLifecycleState>(["creating", "attaching", "attached", "closing", "closed"])
        : terminalLifecycleTransition[current]
    if (allowed.has(next)) {
      setStore("terminalLifecycle", id, next)
      lifecycleDebug.log({ id, from: current, to: next, reason })
      return true
    }
    terminalActionError("transitionLifecycle", {
      terminalId: id,
      reason: `illegal_transition:${current ?? "undefined"}->${next}${reason ? `:${reason}` : ""}`,
    })
    return false
  }

  const assertTerminalInvariant = (action: string, ok: boolean, payload: TerminalInvariantPayload) => {
    if (ok) return true
    terminalActionError(action, payload)
    return false
  }

  const requireTerminalOrigin = (action: string, tabId: string, origin?: TerminalActionOrigin) => {
    if (store.groups.length <= 1) return true
    if (!assertTerminalInvariant(action, !!origin, { origin, targetTab: tabId, reason: "missing_origin" })) return false
    if (!origin) return false
    if (
      !assertTerminalInvariant(action, origin.tabId === tabId, {
        origin,
        targetTab: tabId,
        reason: "origin_tab_mismatch",
      })
    )
      return false
    const groupId = findTabGroup(tabId)
    if (!groupId) return true
    if (origin.groupId === groupId) return true
    return assertTerminalInvariant(action, false, {
      origin,
      targetTab: tabId,
      expectedGroupId: groupId,
      reason: "origin_group_mismatch",
    })
  }

  const requireTerminalInTabPane = (
    action: string,
    tabId: string,
    terminalId: string,
    origin?: TerminalActionOrigin,
  ) => {
    const paneIds = terminalIds(tabId)
    return assertTerminalInvariant(action, paneIds.includes(terminalId), {
      origin,
      targetTab: tabId,
      terminalId,
      paneIds,
      reason: "terminal_not_in_target_tab_pane",
    })
  }

  const requireTerminalOwnerMatchesTab = (
    action: string,
    tabId: string,
    terminalId: string,
    origin?: TerminalActionOrigin,
  ) => {
    const ownerTab = store.terminalOwner[terminalId]
    if (!ownerTab) return true
    return assertTerminalInvariant(action, ownerTab === tabId, {
      origin,
      targetTab: tabId,
      terminalId,
      ownerTab,
      reason: "owner_tab_mismatch",
    })
  }

  const terminal = {
    pendingCreate: pendingTerminalCreate,
    pendingCommand: pendingTerminalCommand,
    pendingDir: pendingTerminalDir,
    pendingGroupId: pendingTerminalGroupId,
    requestCreate: requestTerminalCreate,
    clearPendingCreate: clearPendingTerminalCreate,
    consumePendingCommand: consumePendingTerminalCommand,
    consumePendingCommandForDirectory: consumePendingTerminalCommandForDirectory,
    queueCreateForTab: queuePendingTerminalCreateForTab,
    peekCreateForTab: peekPendingTerminalCreateForTab,
    consumeCreateForTab: consumePendingTerminalCreateForTab,
    clearCreateForTab: clearPendingTerminalCreateForTab,
    creating: creatingTerminal,
    creatingGroupId: creatingTerminalGroupId,
    splitPendingTab,

    beginSplit(tab: string) {
      setSplitPendingTab(tab)
    },

    clearSplitPending(tab?: string) {
      if (!tab || splitPendingTab() === tab) setSplitPendingTab(undefined)
    },

    isClosing(id: string) {
      return closingTerminalIds().includes(id)
    },

    beginClosing(id: string) {
      const lifecycle = untrack(() => store.terminalLifecycle[id])
      const inClosing = untrack(() => closingTerminalIds().includes(id))
      if (lifecycle === "closing" && inClosing) return
      if (lifecycle === "closed") return
      const closingCount = untrack(() => closingTerminalIds().length)
      requestDebug.verbose("beginClosing", {
        id,
        lifecycle,
        closingCount,
      })
      transitionTerminalLifecycle(id, "closing", "beginClosing")
      setClosingTerminalIds((all) => (all.includes(id) ? all : [...all, id]))
    },

    clearClosing(id: string) {
      const lifecycle = untrack(() => store.terminalLifecycle[id])
      const inClosing = untrack(() => closingTerminalIds().includes(id))
      if (!inClosing && lifecycle !== "closing") return
      const closingCount = untrack(() => closingTerminalIds().length)
      requestDebug.verbose("clearClosing", {
        id,
        lifecycle,
        closingCount,
      })
      if (store.terminalLifecycle[id] === "closing") {
        transitionTerminalLifecycle(id, "closed", "clearClosing")
      }
      setClosingTerminalIds((all) => (all.includes(id) ? all.filter((item) => item !== id) : all))
    },

    lifecycle(id: string) {
      return store.terminalLifecycle[id]
    },

    transitionLifecycle(id: string, state: TerminalLifecycleState, reason?: string) {
      return transitionTerminalLifecycle(id, state, reason)
    },

    created() {
      const before = creatingTerminal()
      setCreatingTerminal((n) => Math.max(0, n - 1))
      const after = Math.max(0, before - 1)
      if (after === 0) setCreatingTerminalGroupId(undefined)
      const creatingGroupId = untrack(() => creatingTerminalGroupId())
      const pendingCount = untrack(() => pendingTerminalCreates().length)
      requestDebug.log("created ack", {
        creatingBefore: before,
        creatingAfter: after,
        creatingGroupId,
        pendingCount,
      })
    },

    owner(id: string) {
      return store.terminalOwner[id]
    },

    own(tab: string, id: string) {
      setStore("terminalOwner", id, tab)
    },

    disown(id: string) {
      setStore("terminalOwner", id, undefined)
    },

    /** Return all PTY IDs currently owned by a process (owner starts with "process:"). */
    processOwnedPtyIds(): string[] {
      return Object.entries(store.terminalOwner)
        .filter(([, v]) => typeof v === "string" && v.startsWith("process:"))
        .map(([k]) => k)
    },

    // Process pane integration: defer tab creation while a process start is in flight.
    // The pty.created SSE arrives before process.started, so without this the detection
    // effect creates a tab that gets removed a moment later (visible flicker).
    pendingProcessStarts,
    expectProcessPty() {
      setPendingProcessStarts((n) => n + 1)
    },
    resolveProcessPty() {
      setPendingProcessStarts((n) => Math.max(0, n - 1))
    },
    /** Resolve the initial pending count (set to 1 at creation time).
     *  Called by ProcessPaneProvider when it mounts and doesn't need the
     *  initial deferral (or replaces it with its own expect/resolve pair). */
    resolveInitialProcessPty() {
      setPendingProcessStarts((n) => Math.max(0, n - 1))
    },

    detachFromTab(input: { tab: string; id: string; origin?: TerminalActionOrigin }) {
      if (!requireTerminalOrigin("detachFromTab", input.tab, input.origin)) return
      if (!requireTerminalOwnerMatchesTab("detachFromTab", input.tab, input.id, input.origin)) return
      if (!requireTerminalInTabPane("detachFromTab", input.tab, input.id, input.origin)) return
      closePaneTerminal(input.tab, input.id)
      setStore("terminalOwner", input.id, undefined)
    },

    pane(tab: string) {
      return multiPane.activeLayout(tab)?.pane
    },

    ids(tab: string) {
      return terminalIds(tab)
    },

    ensure(tab: string, id: string) {
      ensurePaneTerminal(tab, id)
    },

    focus(tab: string) {
      return focusedTerminalId(tab)
    },

    setFocus(tab: string, id: string) {
      const leafId = leafForTerminal(tab, id)
      if (!leafId) return
      setLayoutFocus(tab, leafId)
    },

    focusInTab(input: { tab: string; id: string; origin?: TerminalActionOrigin }) {
      if (!requireTerminalOrigin("focusInTab", input.tab, input.origin)) return
      if (!requireTerminalInTabPane("focusInTab", input.tab, input.id, input.origin)) return
      const leafId = leafForTerminal(input.tab, input.id)
      if (!leafId) return
      multiPane.focus(input.tab, leafId)
    },

    zoom(tab: string) {
      return zoomedTerminalId(tab)
    },

    setZoom(tab: string, id: string | undefined) {
      if (!id) {
        setLayoutZoom(tab, undefined)
        return
      }
      const leafId = leafForTerminal(tab, id)
      if (!leafId) return
      setLayoutZoom(tab, leafId)
    },

    zoomInTab(input: { tab: string; id: string; origin?: TerminalActionOrigin }) {
      if (!requireTerminalOrigin("zoomInTab", input.tab, input.origin)) return
      if (!requireTerminalInTabPane("zoomInTab", input.tab, input.id, input.origin)) return
      const leafId = leafForTerminal(input.tab, input.id)
      if (!leafId) return
      multiPane.zoom(input.tab, leafId)
    },

    split(input: { tab: string; at: string; id: string; dir: PaneDir }) {
      splitPaneTerminal(input.tab, input.at, input.id, input.dir)
    },

    splitInTab(input: { tab: string; at: string; id: string; dir: PaneDir; origin?: TerminalActionOrigin }) {
      if (!requireTerminalOrigin("splitInTab", input.tab, input.origin)) return
      if (!requireTerminalOwnerMatchesTab("splitInTab", input.tab, input.id, input.origin)) return
      const ids = terminalIds(input.tab)
      if (
        ids.length > 0 &&
        !assertTerminalInvariant("splitInTab", ids.includes(input.at), {
          origin: input.origin,
          targetTab: input.tab,
          terminalId: input.at,
          paneIds: ids,
          reason: "split_target_not_in_tab",
        })
      ) {
        return
      }
      splitPaneTerminal(input.tab, input.at, input.id, input.dir)
    },

    close(input: { tab: string; id: string }) {
      closePaneTerminal(input.tab, input.id)
    },

    closeInTab(input: { tab: string; id: string; origin?: TerminalActionOrigin }) {
      if (!requireTerminalOrigin("closeInTab", input.tab, input.origin)) return
      if (!requireTerminalOwnerMatchesTab("closeInTab", input.tab, input.id, input.origin)) return
      if (!requireTerminalInTabPane("closeInTab", input.tab, input.id, input.origin)) return
      closePaneTerminal(input.tab, input.id)
    },

    path(input: { tab: string; id: string }) {
      const leafId = leafForTerminal(input.tab, input.id)
      if (!leafId) return
      return paneFindPath(multiPane.activeLayout(input.tab)?.pane, leafId)
    },

    resize(input: { tab: string; path: string; size: number }) {
      multiPane.resize(input.tab, input.path, input.size)
    },

    swap(input: { tab: string; a: string; b: string }) {
      const aLeafId = leafForTerminal(input.tab, input.a)
      const bLeafId = leafForTerminal(input.tab, input.b)
      if (!aLeafId || !bLeafId) return
      multiPane.swap(input.tab, aLeafId, bLeafId)
    },

    replaceId(tab: string, oldId: string, newId: string) {
      const leafId = leafForTerminal(tab, oldId)
      if (leafId) {
        const current = multiPane.getContent(tab, leafId)
        if (current?.type === "terminal") {
          multiPane.setContent(tab, leafId, {
            ...current,
            terminalId: newId,
          })
        }
      }

      for (let i = 0; i < store.groups.length; i++) {
        if (!store.groups[i].tabs.items.some((item) => item.id === tab)) continue
        setStore("groups", i, "tabs", "items", (items) =>
          (items ?? []).map((item) => {
            if (item.id !== tab) return item
            if (item.type !== "terminal") return item
            if (item.terminalId !== oldId) return item
            return { ...item, terminalId: newId }
          }),
        )
        break
      }

      const ownerTab = store.terminalOwner[oldId]
      if (ownerTab) {
        setStore("terminalOwner", newId, ownerTab)
        setStore("terminalOwner", oldId, undefined)
      }

      const lifecycle = store.terminalLifecycle[oldId]
      if (lifecycle) {
        setStore("terminalLifecycle", newId, lifecycle)
        setStore("terminalLifecycle", oldId, undefined)
      }

      const agentStatus = store.terminalAgentStatus[oldId]
      if (agentStatus) {
        setStore("terminalAgentStatus", newId, agentStatus)
        setStore("terminalAgentStatus", oldId, undefined)
      }

      const agentSeen = store.terminalAgentSeen[oldId]
      if (agentSeen) {
        setStore("terminalAgentSeen", newId, agentSeen)
        setStore("terminalAgentSeen", oldId, undefined)
      }
    },

    clear(tab: string) {
      clearTerminalTabState(tab)
      multiPane.clearTab(tab)
    },

    agentStatus(terminalId: string): TerminalAgentStatus {
      return store.terminalAgentStatus[terminalId] ?? "idle"
    },

    /** Returns true if the terminal has received at least one lifecycle event */
    isTracked(terminalId: string): boolean {
      return store.terminalAgentStatus[terminalId] !== undefined
    },

    setAgentStatus(terminalId: string, status: TerminalAgentStatus) {
      // Store "idle" explicitly so isTracked() can distinguish "never seen" from "tracked and idle"
      setStore("terminalAgentStatus", terminalId, status)
      if (status !== "idle") {
        setStore("terminalAgentSeen", terminalId, true)
      }
    },

    clearAgentStatus(terminalId: string) {
      setStore("terminalAgentStatus", terminalId, undefined)
    },

    clearSeen(terminalId: string) {
      setStore("terminalAgentSeen", terminalId, undefined)
    },

    seen(terminalId: string): boolean {
      return !!store.terminalAgentSeen[terminalId]
    },

    getTabAgentStatus(tabId: string): { loading: boolean; attention: boolean; done: boolean } {
      const linked = findTab(tabId)?.terminalId
      const list = terminalIds(tabId)
      const ids = linked && !list.includes(linked) ? [...list, linked] : list

      let hasWorking = false
      let hasPermission = false
      let hasSeen = false

      for (const id of ids) {
        const status = store.terminalAgentStatus[id]
        if (status === "working") hasWorking = true
        if (status === "permission") hasPermission = true
        if (store.terminalAgentSeen[id]) hasSeen = true
      }

      return {
        loading: hasWorking,
        attention: hasPermission,
        done: hasSeen && !hasWorking && !hasPermission,
      }
    },
  }

  return {
    terminal,
    clearTerminalTabState,
    clearStaleCreatingState,
  }
}
