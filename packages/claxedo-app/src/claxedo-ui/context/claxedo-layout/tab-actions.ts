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

      // Diagnostic: detect focus-steal when adding a session tab while terminal is active
      const currentActive = getActiveId()
      if (currentActive && tab.type === "session") {
        const currentTab = getItems().find((t) => t.id === currentActive)
        if (currentTab?.type === "terminal") {
          // eslint-disable-next-line no-console
          console.warn(
            "[tab-actions] FOCUS STEAL via add(): new session tab while terminal active",
            {
              from: { id: currentActive, type: currentTab.type, terminalId: currentTab.terminalId },
              newTab: { id, type: tab.type, sessionId: (tab as { sessionId?: string }).sessionId },
            },
            new Error("stack trace"),
          )
        }
      }

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

    addPage(pageId: string, title: string, directory?: string) {
      const existing = getItems().find((t) => t.type === "page" && t.pageId === pageId)
      if (existing) {
        if (existing.sessionId) {
          setItems((items) => (items ?? []).map((t) => (t.id === existing.id ? { ...t, sessionId: undefined } : t)))
        }
        if (directory && existing.directory !== directory) {
          setItems((items) => (items ?? []).map((t) => (t.id === existing.id ? { ...t, directory } : t)))
        }
        setActiveId(existing.id)
        return existing.id
      }

      return tabActions.add({
        type: "page",
        directory: directory || "__pages__",
        pageId,
        title,
        closable: true,
      })
    },

    close(tabId: string) {
      const items = getItems().map(copy)
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
        const entry = { ...tab, _closedOrderIndex: orderIndex >= 0 ? orderIndex : undefined }
        const list = [entry, ...(closedTabs ?? [])]
        if (list.length <= MAX_CLOSED_TABS) return list
        return list.slice(0, MAX_CLOSED_TABS)
      })()

      const activeId = getActiveId()
      const active = (() => {
        if (activeId !== tabId) return activeId ?? null
        if (filteredItems.length === 0) return null
        const pos = base.indexOf(tabId)
        if (pos === -1) return filteredItems[0]?.id ?? null
        const next = Math.min(pos, filteredItems.length - 1)
        return filteredItems[next]?.id ?? null
      })()

      debug.verbose("close apply", {
        trace,
        tabId,
        filteredItems: filteredItems.length,
        order: order.length,
        closedTabs: closed.length,
        nextActive: active,
      })
      // Diagnostic: detect if closing a terminal tab results in a session tab becoming active
      if (tab.type === "terminal" && active) {
        const nextActiveTab = filteredItems.find((t) => t.id === active)
        if (nextActiveTab?.type === "session") {
          // eslint-disable-next-line no-console
          console.warn(
            "[tab-actions] FOCUS STEAL via close(): terminal closed → session activated",
            {
              closed: { id: tabId, type: tab.type, terminalId: tab.terminalId },
              next: { id: active, type: nextActiveTab.type, sessionId: nextActiveTab.sessionId },
            },
            new Error("stack trace"),
          )
        }
      }
      onClose?.(tab, filteredItems, active)
      debug.verbose("close applied onClose", { trace, tabId })
      setItems(() => filteredItems)
      debug.verbose("close applied setItems", { trace, tabId })
      setOrder(() => order)
      debug.verbose("close applied setOrder", { trace, tabId })
      setClosedTabs(() => closed)
      debug.verbose("close applied setClosedTabs", { trace, tabId })
      setActiveId(active)
      debug.verbose("close applied setActiveId", { trace, tabId })
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
      // Diagnostic: detect focus-steal from terminal → session
      const currentActive = getActiveId()
      if (currentActive && currentActive !== tabId) {
        const currentTab = getItems().find((t) => t.id === currentActive)
        const nextTab = getItems().find((t) => t.id === tabId)
        if (currentTab?.type === "terminal" && nextTab?.type === "session") {
          // eslint-disable-next-line no-console
          console.warn(
            "[tab-actions] FOCUS STEAL: terminal → session",
            {
              from: { id: currentActive, type: currentTab.type, terminalId: currentTab.terminalId },
              to: { id: tabId, type: nextTab.type, sessionId: nextTab.sessionId },
            },
            new Error("stack trace"),
          )
        }
      }
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

    /** Items grouped by directory then flattened — matches the visual tab bar order. */
    visualOrderedItems: (() => {
      const ordered = tabActions.orderedItems()
      const groups = new Map<string, TabItem[]>()
      for (const tab of ordered) {
        const existing = groups.get(tab.directory) || []
        existing.push(tab)
        groups.set(tab.directory, existing)
      }
      return Array.from(groups.values()).flat()
    }) as Accessor<TabItem[]>,

    activateByIndex(index: number) {
      const ordered = tabActions.visualOrderedItems()
      const tab = ordered[index]
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
