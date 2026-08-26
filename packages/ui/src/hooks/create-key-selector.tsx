import { createEffect, createSignal, getObserver, onCleanup, untrack } from "solid-js"

/**
 * O(1) keyed selection for Solid 2 — the `createSelector` Solid 1 had and
 * 2.0.0-rc.1 does not ship.
 *
 * Why not the rc.1 alternatives, measured (contract-bench/framework-micro.ts):
 * - A per-row `createMemo(() => source() === key)` subscribes every row to the
 *   source, so one change re-runs N comparisons (~70ns each).
 * - `createProjection` keyed by id routes through the store commit, which walks
 *   EVERY subscribed key-signal per update (`notifyWrites`/`notifyFold` in
 *   @solidjs/signals) at ~300ns each — slower than the memos it replaces at
 *   every N measured (100 to 2000).
 * This keeps a Map of lazily created per-key signals and a split effect whose
 * apply phase flips exactly the deselected and newly selected keys: O(1) work
 * per selection change and O(1) per subscriber, independent of list size.
 *
 * Entries are refcounted per tracked read and pruned when their last subscriber
 * is cleaned up, so the map tracks live rows rather than growing forever.
 *
 * Must be called where an owner exists (component or root scope) — the flip
 * effect needs one.
 */
export function createKeySelector<T>(source: () => T | undefined): (key: T) => boolean {
  type Entry = { get: () => boolean; set: (value: boolean) => void; refs: number }
  const entries = new Map<T, Entry>()

  createEffect(
    () => source(),
    (next, prev) => {
      if (next === prev) return
      if (prev !== undefined) entries.get(prev)?.set(false)
      if (next !== undefined) entries.get(next)?.set(true)
    },
  )

  return (key: T) => {
    // Untracked reads (event handlers, imperative checks) must not grow the
    // map: only tracked reads are refcounted and pruned, so an entry created
    // for an untracked-only key would live for the selector's lifetime. Answer
    // them directly from the source instead — semantically identical, and
    // allocation-free.
    if (!getObserver()) {
      const entry = entries.get(key)
      return entry ? untrack(entry.get) : untrack(source) === key
    }
    let entry = entries.get(key)
    if (!entry) {
      const [get, set] = createSignal(untrack(source) === key)
      entry = { get, set, refs: 0 }
      entries.set(key, entry)
    }
    const tracked = entry
    tracked.refs++
    onCleanup(() => {
      tracked.refs--
      if (tracked.refs === 0 && entries.get(key) === tracked) entries.delete(key)
    })
    return entry.get()
  }
}
