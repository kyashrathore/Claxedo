import { createContext, createMemo, createRoot, onCleanup, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import { useShellRoute } from "@/shell"
import type { PlacementId } from "@/server"
import { readBrowserBridge } from "./bridge"
import { createBrowserTab, type BrowserTab } from "./tab"

const TAB_CAP = 4

type TabEntry = { readonly tab: BrowserTab; readonly dispose: () => void }

type BrowserTabs = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly tabFor: (placementId: PlacementId) => BrowserTab
}

const BrowserContext = createContext<BrowserTabs>()

function createTabCache(cap: number) {
  const bridge = readBrowserBridge()
  const entries = new Map<PlacementId, TabEntry>()

  const evict = () => {
    for (const [id, entry] of entries) {
      if (entries.size <= cap) return
      entry.dispose()
      entries.delete(id)
    }
  }

  const tabFor = (placementId: PlacementId) => {
    const existing = entries.get(placementId)
    if (existing) {
      entries.delete(placementId)
      entries.set(placementId, existing)
      return existing.tab
    }
    const entry = createRoot((dispose) => ({ tab: createBrowserTab(placementId, bridge), dispose }))
    entries.set(placementId, entry)
    evict()
    return entry.tab
  }

  const disposeAll = () => {
    for (const entry of entries.values()) entry.dispose()
    entries.clear()
  }

  return { tabFor, disposeAll }
}

export function BrowserProvider(props: ParentProps): JSX.Element {
  const placementId = useShellRoute().placementId
  const cache = createTabCache(TAB_CAP)
  onCleanup(cache.disposeAll)
  return (
    <BrowserContext.Provider value={{ placementId, tabFor: cache.tabFor }}>
      {props.children}
    </BrowserContext.Provider>
  )
}

export function useBrowserTab(): Accessor<BrowserTab | undefined> {
  const tabs = useContext(BrowserContext)
  if (!tabs) throw new Error("useBrowserTab needs a BrowserProvider above it")
  return createMemo(() => {
    const placementId = tabs.placementId()
    return placementId ? tabs.tabFor(placementId) : undefined
  })
}
