import { createContext, onCleanup, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import { useShellRoute } from "@/shell"
import { useServer, type PlacementId } from "@/server"
import { readBrowserBridge } from "./bridge"
import type { BrowserTab } from "./tab"
import { createTabCache } from "./tab-cache"

const TAB_CAP = 4

type BrowserTabs = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly tabFor: (placementId: PlacementId) => BrowserTab
  readonly tabs: Accessor<readonly BrowserTab[]>
  readonly closeTab: (placementId: PlacementId) => void
}

const BrowserContext = createContext<BrowserTabs>()

export function BrowserProvider(props: ParentProps): JSX.Element {
  const placementId = useShellRoute().placementId
  const server = useServer()
  const cache = createTabCache(TAB_CAP, readBrowserBridge(), () => server.placements.list().map((placement) => placement.id))
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
