import { createRoot } from "solid-js"
import type { PlacementId } from "@/server"
import type { TerminalStore } from "./store"

type Entry = { readonly store: TerminalStore; readonly dispose: () => void; retained: number }

export type TerminalStoreCache = {
  readonly storeFor: (placementId: PlacementId) => TerminalStore
  readonly retain: (placementId: PlacementId) => () => void
  readonly dispose: () => void
}

export function createTerminalStoreCache(cap: number, create: (placementId: PlacementId) => TerminalStore): TerminalStoreCache {
  const entries = new Map<PlacementId, Entry>()

  const evict = (keep: PlacementId) => {
    for (const [placementId, entry] of entries) {
      if (entries.size <= cap) return
      if (placementId === keep || entry.retained > 0) continue
      entry.dispose()
      entries.delete(placementId)
    }
  }

  const entryFor = (placementId: PlacementId): Entry => {
    const existing = entries.get(placementId)
    if (existing) {
      entries.delete(placementId)
      entries.set(placementId, existing)
      return existing
    }
    const created = createRoot((dispose): Entry => ({ store: create(placementId), dispose, retained: 0 }))
    entries.set(placementId, created)
    evict(placementId)
    return created
  }

  return {
    storeFor: (placementId) => entryFor(placementId).store,
    retain: (placementId) => {
      const entry = entryFor(placementId)
      entry.retained += 1
      return () => {
        entry.retained -= 1
        evict(placementId)
      }
    },
    dispose: () => {
      for (const entry of entries.values()) entry.dispose()
      entries.clear()
    },
  }
}
