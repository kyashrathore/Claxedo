import { createSignal, type Accessor } from "solid-js"

type Entry = { readonly mounted: number; readonly holds: readonly Accessor<boolean>[] }

const EMPTY: Entry = { mounted: 0, holds: [] }

export type RevealHolds = {
  readonly mounted: (contentId: string) => () => void
  readonly hold: (contentId: string, pending: Accessor<boolean>) => () => void
  readonly revealed: (contentId: string) => boolean
}

export function createRevealHolds(): RevealHolds {
  const [entries, setEntries] = createSignal<ReadonlyMap<string, Entry>>(new Map())
  const change = (contentId: string, next: (entry: Entry) => Entry) =>
    setEntries((current) => {
      const entry = next(current.get(contentId) ?? EMPTY)
      const updated = new Map(current)
      if (entry.mounted === 0 && entry.holds.length === 0) updated.delete(contentId)
      else updated.set(contentId, entry)
      return updated
    })
  return {
    mounted: (contentId) => {
      change(contentId, (entry) => ({ ...entry, mounted: entry.mounted + 1 }))
      return () => change(contentId, (entry) => ({ ...entry, mounted: entry.mounted - 1 }))
    },
    hold: (contentId, pending) => {
      change(contentId, (entry) => ({ ...entry, holds: [...entry.holds, pending] }))
      return () => change(contentId, (entry) => ({ ...entry, holds: entry.holds.filter((held) => held !== pending) }))
    },
    revealed: (contentId) => {
      const entry = entries().get(contentId)
      return !!entry && entry.mounted > 0 && entry.holds.every((pending) => !pending())
    },
  }
}
