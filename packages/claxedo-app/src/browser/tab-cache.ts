import { createEffect, createMemo, createRoot, createSignal, on, untrack, type Accessor } from "solid-js"
import type { PlacementId } from "@/server"
import type { BrowserBridge } from "./bridge"
import { createBrowserTab, type BrowserTab } from "./tab"

type TabEntry = { readonly tab: BrowserTab; readonly dispose: () => void; readonly lastAccess: number }

export function createTabCache(
  cap: number,
  bridge: BrowserBridge | undefined,
  placements: Accessor<readonly PlacementId[]>,
) {
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

  closeRemoved(placements, closeTab)
  return { tabFor, disposeAll, closeTab, tabs: createMemo(() => entries().map((entry) => entry.tab)) }
}

function closeRemoved(placements: Accessor<readonly PlacementId[]>, closeTab: (placementId: PlacementId) => void) {
  createEffect(
    on(
      () => new Set(placements()),
      (current, previous) => {
        for (const id of previous ?? []) if (!current.has(id)) closeTab(id)
      },
    ),
  )
}
