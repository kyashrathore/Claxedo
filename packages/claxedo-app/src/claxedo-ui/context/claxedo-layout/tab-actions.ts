import { batch, type Accessor } from "solid-js"
import type { TabItem, TabType, TopTabsState } from "./types"
import { createDebugLogger } from "../../../overrides/utils/debug"

const MAX_CLOSED_TABS = 10
const debug = createDebugLogger("terminal.tab-actions", "terminal:tab-actions", {
  legacyKey: "opencode.debug.terminal",
})

const copy = (tab: TabItem): TabItem => ({
  ...tab,
  badge: tab.badge ? { ...tab.badge } : undefined,
})

export function createTabActions(
  getItems: () => TabItem[],
  getActiveId: () => string | null,
  getOrder: () => string[],
  getClosedTabs: () => TabItem[],
  setItems: (fn: (items: TabItem[]) => TabItem[]) => void,
  setActiveId: (id: string | null) => void,
  setOrder: (fn: (order: string[]) => string[]) => void,
  setClosedTabs: (fn: (tabs: TabItem[]) => TabItem[]) => void,
  produceAll: (fn: (draft: TopTabsState) => void) => void,
  onClose?: (tab: TabItem, remainingItems: TabItem[], newActiveId: string | null) => void,
  onAdd?: (tab: TabItem) => void,
  onReopen?: (tab: TabItem) => boolean | void,
) {
  const tabActions = {
    items: (() => getItems()) as Accessor<TabItem[]>,
    activeId: (() => getActiveId()) as Accessor<string | null>,
    order: (() => getOrder()) as Accessor<string[]>,
    active: (() => {
      const id = getActiveId()
      if (!id) return undefined
      return getItems().find((t) => t.id === id)
    }) as Accessor<TabItem | undefined>,

    hasType(type: TabType) {
      return getItems().some((t) => t.type === type)
    },

    findByType(type: TabType) {
      return getItems().filter((t) => t.type === type)
    },

    findSession(dir: string, sessionId: string) {
      return getItems().find((t) => t.type === "session" && t.directory === dir && t.sessionId === sessionId)
    },

    findTerminal(dir: string, terminalId: string) {
      return getItems().find((t) => t.type === "terminal" && t.directory === dir && t.terminalId === terminalId)
    },

    patch(id: string, patch: Partial<TabItem>) {
      setItems((items) =>
        (items ?? []).map((t) => {
          if (t.id !== id) return t
          return { ...t, ...patch }
        }),
      )
    },

    add(tab: Omit<TabItem, "id">) {
      const id = `${tab.type}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      const newTab: TabItem = { ...tab, id }

      debug.log("add tab", {
        id,
        type: tab.type,
        sessionId: tab.type === "session" ? (tab as { sessionId?: string }).sessionId : undefined,
        directory: tab.directory,
        existingCount: getItems().length,
      })

      batch(() => {
        setItems((items) => [...(items || []), newTab])
        setOrder((order) => [...(order || []), id])
        setActiveId(id)
        onAdd?.(newTab)
      })

      return id
    },

    addSession(dir: string, sessionId: string, title: string, badge?: TabItem["badge"]) {
      if (!dir) return ""

      const existing = getItems().find((t) => t.type === "session" && t.directory === dir && t.sessionId === sessionId)
      if (existing) {
        const nextA = badge?.additions
        const nextD = badge?.deletions
        const prevA = existing.badge?.additions
        const prevD = existing.badge?.deletions
        const sameBadge = nextA === prevA && nextD === prevD
        const sameTitle = existing.title === title
        if (sameTitle && sameBadge) return existing.id
        setItems((items) => {
          const list = items ?? []
          return list.map((t) => {
            if (t.id !== existing.id) return t

            const sameTitle = t.title === title
            const prevA = t.badge?.additions
            const prevD = t.badge?.deletions
            const sameBadge = nextA === prevA && nextD === prevD

            if (sameTitle && sameBadge) return t
            return { ...t, title, badge }
          })
        })
        return existing.id
      }

      return tabActions.add({
        type: "session",
        directory: dir,
        sessionId,
        title,
        badge,
        closable: true,
      })
    },

    addTerminal(dir: string, terminalId: string, title: string) {
      if (!dir) return ""

      const existing = getItems().find(
        (t) => t.type === "terminal" && t.directory === dir && t.terminalId === terminalId,
      )
      if (existing) {
        setActiveId(existing.id)
        return existing.id
      }

      return tabActions.add({
        type: "terminal",
        directory: dir,
        terminalId,
        title,
        closable: true,
      })
    },

    addReview(
      dir: string,
      sessionId: string,
      title: string,
      badge?: TabItem["badge"],
      reviewMode?: TabItem["reviewMode"],
      reviewFromRef?: string,
      reviewToRef?: string,
    ) {
      if (!dir) return ""

      const existing = getItems().find(
        (t) =>
          t.type === "review" &&
          t.directory === dir &&
          t.sessionId === sessionId &&
          (t.reviewMode ?? "session") === (reviewMode ?? "session") &&
          (t.reviewFromRef ?? "") === (reviewFromRef ?? "") &&
          (t.reviewToRef ?? "") === (reviewToRef ?? ""),
      )
      if (existing) {
        setActiveId(existing.id)
        return existing.id
      }

      return tabActions.add({
        type: "review",
        directory: dir,
        sessionId,
        title: `Review: ${title}`,
        badge,
        reviewMode,
        reviewFromRef,
        reviewToRef,
        closable: true,
      })
    },

    addReviewWorkspace(
      dir: string,
      sessionId: string,
      title: string,
      badge?: TabItem["badge"],
      reviewMode?: TabItem["reviewMode"],
      reviewFromRef?: string,
      reviewToRef?: string,
    ) {
      if (!dir) return ""

      const existing = getItems().find(
        (t) =>
          t.type === "review-workspace" &&
          t.directory === dir &&
          t.sessionId === sessionId &&
          (t.reviewMode ?? "session") === (reviewMode ?? "session") &&
          (t.reviewFromRef ?? "") === (reviewFromRef ?? "") &&
          (t.reviewToRef ?? "") === (reviewToRef ?? ""),
      )
      if (existing) {
        setActiveId(existing.id)
        return existing.id
      }

      return tabActions.add({
        type: "review-workspace",
        directory: dir,
        sessionId,
        title: `Review: ${title}`,
        badge,
        reviewMode,
        reviewFromRef,
        reviewToRef,
        closable: true,
      })
    },

    addContext(dir: string, sessionId: string, title: string) {
      if (!dir || !sessionId) return ""

      const existing = getItems().find((t) => t.type === "context" && t.directory === dir && t.sessionId === sessionId)
      if (existing) {
        setActiveId(existing.id)
        return existing.id
      }

      return tabActions.add({
        type: "context",
        directory: dir,
        sessionId,
        title,
        closable: true,
      })
    },

    addFile(dir: string, filePath: string, title: string) {
      if (!dir) return ""

      const existing = getItems().find((t) => t.type === "file" && t.directory === dir && t.filePath === filePath)
      if (existing) {
        setActiveId(existing.id)
        return existing.id
      }

      return tabActions.add({
        type: "file",
        directory: dir,
        filePath,
        title,
        closable: true,
      })
    },

    addProcess(dir: string) {
      const existing = getItems().find((t) => t.type === "process" && t.directory === dir)
      if (existing) {
        setActiveId(existing.id)
        return existing.id
      }

      return tabActions.add({
        type: "process",
        directory: dir,
        title: "Processes",
        closable: true,
      })
    },

    addPage(pageId: string, title: string, directory?: string, filePath?: string) {
      const existing = getItems().find((t) => t.type === "page" && t.pageId === pageId)
      if (existing) {
        if (existing.sessionId) {
          setItems((items) => (items ?? []).map((t) => (t.id === existing.id ? { ...t, sessionId: undefined } : t)))
        }
        if (directory && existing.directory !== directory) {
          setItems((items) => (items ?? []).map((t) => (t.id === existing.id ? { ...t, directory } : t)))
        }
        if (filePath && existing.filePath !== filePath) {
          setItems((items) => (items ?? []).map((t) => (t.id === existing.id ? { ...t, filePath } : t)))
        }
        setActiveId(existing.id)
        return existing.id
      }

      return tabActions.add({
        type: "page",
        directory: directory || "__pages__",
        pageId,
        filePath,
        title,
        closable: true,
      })
    },

    close(tabId: string) {
      const items = getItems()
      if (!items || !Array.isArray(items)) return

      const index = items.findIndex((t) => t.id === tabId)
      if (index === -1) return

      const tab = items[index]
      if (!tab?.closable) return
      const trace = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      debug.log("close start", {
        trace,
        tabId,
        tabType: tab.type,
        items: items.length,
        order: getOrder().length,
        closedTabs: getClosedTabs().length,
        activeId: getActiveId(),
      })

      const filteredItems = items.filter((t) => t.id !== tabId)
      const currentOrder = getOrder()
      const base = currentOrder?.length ? currentOrder : items.map((item) => item.id)
      const order = (() => {
        const list = base.filter((id) => id !== tabId)
        const seen = new Set(list)
        const missing = filteredItems.filter((item) => !seen.has(item.id)).map((item) => item.id)
        if (missing.length === 0) return list
        return [...list, ...missing]
      })()

      const closedTabs = getClosedTabs().map(copy)
      const orderIndex = base.indexOf(tabId)
      const closed = (() => {
        const entry = { ...copy(tab), _closedOrderIndex: orderIndex >= 0 ? orderIndex : undefined }
        const list = [entry, ...(closedTabs ?? [])]
        if (list.length <= MAX_CLOSED_TABS) return list
        return list.slice(0, MAX_CLOSED_TABS)
      })()

      const activeId = getActiveId()
      const active = (() => {
        if (activeId !== tabId) return activeId ?? null
        if (filteredItems.length === 0) return null
        const pos = base.indexOf(tabId)
        if (pos === -1) {
          const same = filteredItems.find((item) => item.directory === tab.directory)
          if (same) return same.id
          return filteredItems[0]?.id ?? null
        }

        const byId = new Map(filteredItems.map((item) => [item.id, item] as const))
        const ranked = [...base.slice(pos + 1), ...base.slice(0, pos).reverse()]
          .map((id) => byId.get(id))
          .filter((item): item is TabItem => !!item)
        const same = ranked.find((item) => item.directory === tab.directory)
        if (same) return same.id
        return ranked[0]?.id ?? filteredItems[0]?.id ?? null
      })()

      debug.verbose("close apply", {
        trace,
        tabId,
        filteredItems: filteredItems.length,
        order: order.length,
        closedTabs: closed.length,
        nextActive: active,
      })
      const apply = (stage: string, fn: () => void) => {
        try {
          fn()
        } catch (error) {
          debug.log("close stage failed", {
            trace,
            tabId,
            stage,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          })
          throw error
        }
      }
      batch(() => {
        apply("onClose", () => onClose?.(tab, filteredItems, active))
        apply("setItems", () => setItems(() => filteredItems))
        apply("setOrder", () => setOrder(() => order))
        apply("setClosedTabs", () => setClosedTabs(() => closed))
        apply("setActiveId", () => setActiveId(active))
      })
      debug.log("close end", { trace, tabId })
    },

    closeActive() {
      const id = getActiveId()
      if (!id) return
      tabActions.close(id)
    },

    reopenLast() {
      const closedTabs = getClosedTabs()
      const lastClosed = closedTabs[0]
      if (!lastClosed) return

      // If onReopen returns true, the callback handled the tab itself
      // (e.g. terminal tabs clone from disk history instead of restoring stale state).
      // Just pop from closedTabs and return.
      if (onReopen?.(lastClosed)) {
        setClosedTabs((tabs) => tabs.slice(1))
        return
      }

      const savedIndex = (lastClosed as TabItem & { _closedOrderIndex?: number })._closedOrderIndex
      produceAll((draft) => {
        draft.closedTabs.shift()
        draft.items.push(lastClosed)
        if (savedIndex !== undefined && savedIndex >= 0 && savedIndex <= draft.order.length) {
          draft.order.splice(savedIndex, 0, lastClosed.id)
        } else {
          draft.order.push(lastClosed.id)
        }
        draft.activeId = lastClosed.id
      })
    },

    setActive(tabId: string) {
      produceAll((draft) => {
        if (!draft || !draft.items) return
        const exists = draft.items.find((t) => t.id === tabId)
        if (exists) {
          draft.activeId = tabId
        }
      })
    },

    move(tabId: string, toIndex: number) {
      const currentOrder = getOrder()
      const fromIndex = currentOrder.indexOf(tabId)
      if (fromIndex === undefined || fromIndex === -1 || fromIndex === toIndex) return

      setOrder((order) => {
        const list = [...order]
        const [moved] = list.splice(fromIndex, 1)
        list.splice(toIndex, 0, moved)
        return list
      })
    },

    updateBadge(tabId: string, badge: TabItem["badge"]) {
      setItems((items) =>
        items.map((t, i) => {
          if (t.id !== tabId) return t
          return { ...t, badge }
        }),
      )
    },

    updateTitle(tabId: string, title: string) {
      setItems((items) => {
        const idx = items.findIndex((t) => t.id === tabId)
        if (idx === -1 || items[idx].title === title) return items
        return items.map((t) => (t.id === tabId ? { ...t, title } : t))
      })
    },

    orderedItems: (() => {
      const items = getItems()
      const currentOrder = getOrder()
      const base = currentOrder.length ? currentOrder : items.map((item) => item.id)
      const seen = new Set(base)
      const missing = items.filter((item) => !seen.has(item.id)).map((item) => item.id)
      const order = missing.length ? [...base, ...missing] : base

      return order.map((id) => items.find((t) => t.id === id)).filter((t): t is TabItem => !!t)
    }) as Accessor<TabItem[]>,

    /** Items grouped by directory then flattened — matches the visual tab bar order.
     *  Unpinned tabs establish group order; pinned tabs are then prepended within their own group. */
    visualOrderedItems: (() => {
      const items = getItems()
      const currentOrder = getOrder()
      const base = currentOrder.length ? currentOrder : items.map((item) => item.id)
      const seen = new Set(base)
      const missing = items.filter((item) => !seen.has(item.id)).map((item) => item.id)
      const order = missing.length ? [...base, ...missing] : base
      const ordered: TabItem[] = order
        .map((id) => items.find((t) => t.id === id))
        .filter((t): t is TabItem => !!t)

      const groups = new Map<string, { pinned: TabItem[]; unpinned: TabItem[] }>()
      const groupOrder: string[] = []
      const ensure = (directory: string) => {
        let entry = groups.get(directory)
        if (entry) return entry
        entry = { pinned: [], unpinned: [] }
        groups.set(directory, entry)
        groupOrder.push(directory)
        return entry
      }

      for (const tab of ordered) {
        if (tab.pinned) continue
        ensure(tab.directory).unpinned.push(tab)
      }

      for (const tab of ordered) {
        if (!tab.pinned) continue
        ensure(tab.directory).pinned.push(tab)
      }
      return groupOrder.flatMap((directory) => {
        const group = groups.get(directory)
        if (!group) return []
        return [...group.pinned, ...group.unpinned]
      })
    }) as Accessor<TabItem[]>,

    activateByIndex(index: number) {
      const ordered = tabActions.visualOrderedItems()
      const unpinned = ordered.filter((t) => !t.pinned)
      const tab = unpinned[index]
      if (tab) setActiveId(tab.id)
    },

    activateNext() {
      const ordered = tabActions.orderedItems()
      const currentIndex = ordered.findIndex((t) => t.id === getActiveId())
      if (currentIndex === -1) return
      const nextIndex = (currentIndex + 1) % ordered.length
      if (ordered[nextIndex]) setActiveId(ordered[nextIndex].id)
    },

    activatePrevious() {
      const ordered = tabActions.orderedItems()
      const currentIndex = ordered.findIndex((t) => t.id === getActiveId())
      if (currentIndex === -1) return
      const prevIndex = (currentIndex - 1 + ordered.length) % ordered.length
      if (ordered[prevIndex]) setActiveId(ordered[prevIndex].id)
    },
  }

  return tabActions
}
