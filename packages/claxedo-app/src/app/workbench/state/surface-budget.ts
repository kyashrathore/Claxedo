// Surface budget — the LRU cap on how many tabs the workbench keeps open.
//
// Open surfaces are unbounded by construction: every `openSession` /
// `openTerminal` / `openPage` that finds no existing meta appends a new
// contentId, and nothing ever reaps one. Tabs whose backing session or
// workspace has since disappeared render as "Session unavailable" forever, and
// the whole `claxedo.state.v5` blob is rewritten to localStorage on every state
// change — so an unbounded tab list is both a UI problem and a write-amplifier.
//
// The rule is a plain LRU over `contentRecency` (MRU-first) with two
// exemptions that are not up for eviction:
//
//   - contents mounted in a pane — evicting what the user is looking at (or
//     what sits in the other half of a split) is never the right answer.
//   - pinned built-ins — `pages-index` refuses to close via `closeContent`, so
//     evicting it here would desync the two paths.
//
// Exemptions come out of the same budget rather than sitting on top of it, so
// `max` really is the ceiling on tab count. If the exempt set alone meets or
// exceeds `max`, every remaining candidate is evictable.

/** Ceiling on simultaneously open surfaces (tabs) in the workbench. */
export const MAX_OPEN_SURFACES = 10

export type SurfaceBudgetInput = {
  contentIds: readonly string[]
  /** MRU-first, as maintained by the workbench reducers. */
  contentRecency: readonly string[]
  /** Contents currently assigned to a pane. Never evicted. */
  mountedIds?: Iterable<string>
  /** Contents that refuse to close (pinned built-ins). Never evicted. */
  pinnedIds?: Iterable<string>
  max?: number
}

/**
 * Ids to evict so that at most `max` surfaces remain, MRU-first in the returned
 * array. Returns `[]` when already within budget.
 */
export function selectEvictableSurfaces(input: SurfaceBudgetInput): string[] {
  const max = Math.max(0, input.max ?? MAX_OPEN_SURFACES)

  // `contentIds` is not deduped by `validate`, and a duplicate would otherwise
  // be counted twice against the budget and evicted twice.
  const alive: string[] = []
  const seen = new Set<string>()
  for (const id of input.contentIds) {
    if (seen.has(id)) continue
    seen.add(id)
    alive.push(id)
  }
  if (alive.length <= max) return []

  const exempt = new Set<string>()
  for (const id of input.mountedIds ?? []) if (seen.has(id)) exempt.add(id)
  for (const id of input.pinnedIds ?? []) if (seen.has(id)) exempt.add(id)

  // Rank by recency position. Ids absent from `contentRecency` sort last — they
  // are the least trustworthy entries in the blob, so they go first.
  const rank = new Map<string, number>()
  input.contentRecency.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index)
  })
  const order = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER

  const candidates = alive
    .filter((id) => !exempt.has(id))
    .sort((a, b) => order(a) - order(b))

  const keep = Math.max(0, max - exempt.size)
  return candidates.slice(keep)
}
