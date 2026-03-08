import { createEffect, on, type Accessor } from "solid-js"
import { produce, type SetStoreFunction } from "solid-js/store"
import { createTabActions } from "./tab-actions"
import { getTabHooks as getTabHooksFromRegistry, type TabLifecycleHooks } from "./tab-type-registry"
import { type ClaxedoLayoutStore } from "./types"
import { createDebugLogger } from "../../../overrides/utils/debug"
import type { TabItem, TopTabsState, TabType } from "./types"

export function createGroupAccessors(input: {
  store: ClaxedoLayoutStore
  setStore: SetStoreFunction<ClaxedoLayoutStore>
  focusedGroup: () => ClaxedoLayoutStore["groups"][number] | undefined
  getTabHooks?: (type: TabType) => TabLifecycleHooks | undefined
}) {
  const { store, setStore, focusedGroup } = input
  const getTabHooks = input.getTabHooks ?? getTabHooksFromRegistry
  const debug = createDebugLogger("terminal.groups", "terminal:groups", {
    legacyKey: "opencode.debug.terminal",
  })
  const real = (dir?: string | null) => {
    if (!dir || dir === "__process__") return
    return dir
  }

  const groupTabsCache = new Map<string, ReturnType<typeof createTabActions>>()

  const groupTabs = (groupId: string) => {
    const cached = groupTabsCache.get(groupId)
    if (cached) return cached

    const idx = () => store.groups.findIndex((g) => g.id === groupId)
    const slim = (tabs: TabItem[]) =>
      tabs.map((tab) => ({
        id: tab.id,
        type: tab.type,
        dir: tab.directory,
      }))
    const setGroupItems = (fn: (items: TabItem[]) => TabItem[]) => {
      const i = idx()
      if (i === -1) return
      const current = store.groups[i]?.tabs.items ?? []
      const next = fn(current)
      debug.log("set tabs.items", {
        groupId,
        idx: i,
        hasGroup: true,
        groupCount: store.groups.length,
        before: slim(current),
        after: slim(next),
        activeId: store.groups[i]?.tabs.activeId ?? null,
      })
      setStore("groups", i, "tabs", "items", next)
    }
    const setGroupActive = (id: string | null) => {
      const i = idx()
      if (i === -1) return
      debug.log("set tabs.activeId", {
        groupId,
        idx: i,
        hasGroup: true,
        prevActive: store.groups[i]?.tabs.activeId ?? null,
        nextActive: id,
      })
      setStore("groups", i, "tabs", "activeId", id)
    }
    const setGroupOrder = (fn: (order: string[]) => string[]) => {
      const i = idx()
      if (i === -1) return
      const current = store.groups[i]?.tabs.order ?? []
      const next = fn(current)
      debug.log("set tabs.order", {
        groupId,
        idx: i,
        hasGroup: true,
        before: current,
        after: next,
      })
      setStore("groups", i, "tabs", "order", next)
    }
    const setGroupClosedTabs = (fn: (tabs: TabItem[]) => TabItem[]) => {
      const i = idx()
      if (i === -1) return
      const current = store.groups[i]?.tabs.closedTabs ?? []
      const next = fn(current)
      debug.log("set tabs.closedTabs", {
        groupId,
        idx: i,
        hasGroup: true,
        before: slim(current),
        after: slim(next),
      })
      setStore("groups", i, "tabs", "closedTabs", next)
    }
    const produceGroupTabs = (fn: (draft: TopTabsState) => void) => {
      const i = idx()
      debug.verbose("produce tabs", {
        groupId,
        idx: i,
        hasGroup: i !== -1,
      })
      if (i === -1) return
      setStore("groups", i, "tabs", produce(fn))
    }
    const actions = createTabActions(
      () => store.groups[idx()]?.tabs.items ?? [],
      () => store.groups[idx()]?.tabs.activeId ?? null,
      () => store.groups[idx()]?.tabs.order ?? [],
      () => store.groups[idx()]?.tabs.closedTabs ?? [],
      setGroupItems,
      setGroupActive,
      setGroupOrder,
      setGroupClosedTabs,
      produceGroupTabs,
      (tab, remainingItems, newActiveId) => {
        getTabHooks(tab.type)?.onClose?.(tab.id, tab)

        // Update worktree.default when last tab for that directory is closed
        const i = idx()
        if (i === -1) return
        const currentDefault = store.groups[i].worktree.default
        if (!currentDefault || currentDefault !== tab.directory) return
        const hasOther = remainingItems.some((t) => t.directory === currentDefault)
        if (hasOther) return
        // Only switch if there's a next active tab; if no tabs remain, keep current default
        const newActive = remainingItems.find((t) => t.id === newActiveId)
        const next = real(newActive?.directory) ?? real(remainingItems.find((t) => real(t.directory))?.directory)
        if (next) setStore("groups", i, "worktree", "default", next)
      },
      (tab) => {
        getTabHooks(tab.type)?.onAdd?.(tab)

        const dir = real(tab.directory)
        if (!dir) return
        const i = idx()
        if (i === -1) return
        if (real(store.groups[i].worktree.default)) return
        setStore("groups", i, "worktree", "default", dir)
      },
      (tab) => {
        const hooks = getTabHooks(tab.type)
        if (!hooks?.onReopen) return false
        return hooks.onReopen(tab, { addTerminal: actions.addTerminal, groupId }) ?? false
      },
    )
    groupTabsCache.set(groupId, actions)
    return actions
  }

  createEffect(
    on(
      () => store.groups.map((g) => g.id),
      (ids) => {
        for (const key of groupTabsCache.keys()) {
          if (!ids.includes(key)) groupTabsCache.delete(key)
        }
      },
    ),
  )

  const groupWorktree = (groupId: string) => {
    const idx = () => store.groups.findIndex((g) => g.id === groupId)
    return {
      default: (() => store.groups[idx()]?.worktree.default ?? null) as Accessor<string | null>,
      pinned: (() => store.groups[idx()]?.worktree.pinned ?? null) as Accessor<string | null>,
      setDefault(dir: string | null) {
        const i = idx()
        if (i === -1) return
        setStore("groups", i, "worktree", "default", dir)
      },
      setPinned(dir: string | null) {
        const i = idx()
        if (i === -1) return
        setStore("groups", i, "worktree", "pinned", dir)
      },
    }
  }

  const groupLayout = (groupId: string) => {
    return {
      session: {
        width: (() => 600) as Accessor<number>,
        collapsed: (() => false) as Accessor<boolean>,
        panelMode: (() => 0) as Accessor<number>,
        setWidth(_v: number) {},
        setCollapsed(_v: boolean) {},
        setPanelMode(_v: number) {},
      },
      reviewPanel: {
        opened: (() => false) as Accessor<boolean>,
        setOpened(_v: boolean) {},
      },
    }
  }

  const worktree = {
    default: (() => focusedGroup()?.worktree.default ?? null) as Accessor<string | null>,
    pinned: (() => focusedGroup()?.worktree.pinned ?? null) as Accessor<string | null>,

    setDefault(dir: string | null) {
      const g = focusedGroup()
      if (!g) return
      const i = store.groups.findIndex((gr) => gr.id === g.id)
      if (i === -1) return
      if (dir === store.groups[i].worktree.default) return
      setStore("groups", i, "worktree", "default", dir)
    },

    setPinned(dir: string | null) {
      const g = focusedGroup()
      if (!g) return
      const i = store.groups.findIndex((gr) => gr.id === g.id)
      if (i === -1) return
      if (dir === store.groups[i].worktree.pinned) return
      setStore("groups", i, "worktree", "pinned", dir)
    },
  }

  const topTabs = createTabActions(
    () => {
      const g = focusedGroup()
      return g?.tabs.items ?? []
    },
    () => {
      const g = focusedGroup()
      const id = g?.tabs.activeId ?? null
      // In split mode, empty groups are intentional — return a sentinel to
      // prevent the "ensure active tab" effect from auto-creating a session.
      if (!id && store.groups.length > 1) return "__split_empty__"
      return id
    },
    () => {
      const g = focusedGroup()
      return g?.tabs.order ?? []
    },
    () => {
      const g = focusedGroup()
      return g?.tabs.closedTabs ?? []
    },
    (fn) => {
      const g = focusedGroup()
      if (!g) return
      const i = store.groups.findIndex((gr) => gr.id === g.id)
      if (i === -1) return
      const current = store.groups[i]?.tabs.items ?? []
      const next = fn(current)
      setStore("groups", i, "tabs", "items", next)
    },
    (id) => {
      const g = focusedGroup()
      if (!g) return
      const i = store.groups.findIndex((gr) => gr.id === g.id)
      if (i === -1) return
      setStore("groups", i, "tabs", "activeId", id)
    },
    (fn) => {
      const g = focusedGroup()
      if (!g) return
      const i = store.groups.findIndex((gr) => gr.id === g.id)
      if (i === -1) return
      const current = store.groups[i]?.tabs.order ?? []
      const next = fn(current)
      setStore("groups", i, "tabs", "order", next)
    },
    (fn) => {
      const g = focusedGroup()
      if (!g) return
      const i = store.groups.findIndex((gr) => gr.id === g.id)
      if (i === -1) return
      const current = store.groups[i]?.tabs.closedTabs ?? []
      const next = fn(current)
      setStore("groups", i, "tabs", "closedTabs", next)
    },
    (fn) => {
      const g = focusedGroup()
      if (!g) return
      const i = store.groups.findIndex((gr) => gr.id === g.id)
      if (i === -1) return
      setStore("groups", i, "tabs", produce(fn))
    },
    (tab, remainingItems, newActiveId) => {
      getTabHooks(tab.type)?.onClose?.(tab.id, tab)

      // Update worktree.default when last tab for that directory is closed
      const g = focusedGroup()
      if (!g) return
      const i = store.groups.findIndex((gr) => gr.id === g.id)
      if (i === -1) return
      const currentDefault = store.groups[i].worktree.default
      if (!currentDefault || currentDefault !== tab.directory) return
      const hasOther = remainingItems.some((t) => t.directory === currentDefault)
      if (hasOther) return
      // Only switch if there's a next active tab; if no tabs remain, keep current default
      const newActive = remainingItems.find((t) => t.id === newActiveId)
      const next = real(newActive?.directory) ?? real(remainingItems.find((t) => real(t.directory))?.directory)
      if (next) setStore("groups", i, "worktree", "default", next)
    },
    (tab) => {
      getTabHooks(tab.type)?.onAdd?.(tab)

      const dir = real(tab.directory)
      if (!dir) return
      const g = focusedGroup()
      if (!g) return
      const i = store.groups.findIndex((gr) => gr.id === g.id)
      if (i === -1) return
      if (real(store.groups[i].worktree.default)) return
      setStore("groups", i, "worktree", "default", dir)
    },
    (tab) => {
      const hooks = getTabHooks(tab.type)
      if (!hooks?.onReopen) return false
      const g = focusedGroup()
      return hooks.onReopen(tab, { addTerminal: topTabs.addTerminal, groupId: g?.id ?? "" }) ?? false
    },
  )

  return {
    groupTabs,
    groupWorktree,
    groupLayout,
    topTabs,
    worktree,
  }
}
