import type { TabItem, TabType } from "./types"

export type TabReopenHelper = {
  addTerminal: (directory: string, terminalId: string, title: string) => string | undefined
  groupId: string
}

export type TabLifecycleHooks = {
  onClose?: (tabId: string, tab: TabItem) => void
  onAdd?: (tab: TabItem) => void
  onReopen?: (tab: TabItem, helper: TabReopenHelper) => boolean
  excludeFromMerge?: boolean
  mergeDedupeKey?: (tab: TabItem) => string | undefined
  onMergeDrop?: (tabId: string, tab: TabItem) => void
}

export type TabTypeRegistry = {
  register: (type: TabType, hooks: TabLifecycleHooks) => void
  get: (type: TabType) => TabLifecycleHooks | undefined
  reset: () => void
}

export function createTabTypeRegistry(): TabTypeRegistry {
  const map = new Map<TabType, TabLifecycleHooks>()
  return {
    register(type, hooks) {
      map.set(type, hooks)
    },
    get(type) {
      return map.get(type)
    },
    reset() {
      map.clear()
    },
  }
}

const globalRegistry = createTabTypeRegistry()

export function registerTabType(type: TabType, hooks: TabLifecycleHooks) {
  globalRegistry.register(type, hooks)
}

export function getTabHooks(type: TabType): TabLifecycleHooks | undefined {
  return globalRegistry.get(type)
}

export function resetTabTypeRegistry() {
  globalRegistry.reset()
}
