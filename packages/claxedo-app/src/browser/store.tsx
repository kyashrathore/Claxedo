import {
  createContext,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  untrack,
  useContext,
  type Accessor,
  type JSX,
  type ParentProps,
} from "solid-js"
import { useShellRoute } from "@/shell"
import type { PlacementId } from "@/server"
import { readBrowserBridge } from "./bridge"
import { createBrowserTab, type BrowserTab } from "./tab"

const TAB_CAP = 4

type TabEntry = { readonly tab: BrowserTab; readonly dispose: () => void; readonly lastAccess: number }

type BrowserTabs = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly tabFor: (placementId: PlacementId) => BrowserTab
  readonly tabs: Accessor<readonly BrowserTab[]>
  readonly closeTab: (placementId: PlacementId) => void
}

const BrowserContext = createContext<BrowserTabs>()

function createTabCache(cap: number) {
  const bridge = readBrowserBridge()
  const [entries, setEntries] = createSignal<readonly TabEntry[]>([])
  let accessVersion = 0

  const tabFor = (placementId: PlacementId) => {
    const previous = untrack(entries)
    const lastAccess = ++accessVersion
    const existing = previous.find((entry) => entry.tab.placementId === placementId)
    if (existing) {
      setEntries(previous.map((entry) => (entry === existing ? { ...entry, lastAccess } : entry)))
      return existing.tab
    }
    const entry = createRoot((dispose) => ({ tab: createBrowserTab(placementId, bridge), dispose, lastAccess }))
    const next = [...previous, entry]
    const oldest =
      next.length > cap ? next.reduce((left, right) => (left.lastAccess < right.lastAccess ? left : right)) : undefined
    oldest?.dispose()
    setEntries(next.filter((item) => item !== oldest))
    return entry.tab
  }

  const disposeAll = () => {
    for (const entry of untrack(entries)) entry.dispose()
    setEntries([])
  }

  const closeTab = (placementId: PlacementId) => {
    const previous = untrack(entries)
    previous.find((entry) => entry.tab.placementId === placementId)?.dispose()
    setEntries(previous.filter((entry) => entry.tab.placementId !== placementId))
  }
  return { tabFor, disposeAll, closeTab, tabs: createMemo(() => entries().map((entry) => entry.tab)) }
}

export function BrowserProvider(props: ParentProps): JSX.Element {
  const placementId = useShellRoute().placementId
  const cache = createTabCache(TAB_CAP)
  onCleanup(cache.disposeAll)
  return (
    <BrowserContext.Provider value={{ placementId, tabFor: cache.tabFor, tabs: cache.tabs, closeTab: cache.closeTab }}>
      {props.children}
    </BrowserContext.Provider>
  )
}

export function useBrowserTabs(): BrowserTabs {
  const tabs = useContext(BrowserContext)
  if (!tabs) throw new Error("useBrowserTabs needs a BrowserProvider above it")
  return tabs
}
