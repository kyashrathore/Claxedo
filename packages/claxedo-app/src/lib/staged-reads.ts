/**
 * Same-task read-your-writes for store-backed slices.
 *
 * Solid 2 stages store writes until the scheduler flushes, so a plain committed
 * read in the same task as a mutation does not see it. That is correct for
 * rendering — it is what keeps a flush consistent — but our slices expose
 * imperative APIs that callers chain within one task (open then read, upsert
 * then look up, set status then read `seen`). Those reads must observe the
 * writes that just happened.
 *
 * This is the mechanism `useWorkbench().apply` already used for the workbench
 * slice, extracted so every slice shares one implementation instead of
 * re-deriving it. Reads still touch the store FIRST, so reactive tracking and
 * wake granularity are unchanged — the overlay only supplies a fresher value
 * for the current task.
 *
 * The overlay clears on a microtask, which is strictly shorter than the
 * scheduler's flush window, so it can never mask a committed value.
 *
 * WHY NOT THE FRAMEWORK'S OWN DRAFT. Solid 2 does expose a staged view: the
 * `$state` handed to `setStore(($state) => ...)` reflects every write staged so
 * far in the task, across separate setter calls, including `storePath` writes,
 * key deletes and whole-object assignment. A callback that only reads stages
 * nothing, so `setStore(($state) => { out = read($state) })` is a legitimate,
 * allocation-free staged read (~1.3us over a 2000-entry record) — and it is
 * what these slices should use where it fits.
 *
 * It does not fit here, and the reason is worth stating so nobody re-derives
 * it: a draft is live only INSIDE its callback. `$state.meta[id]` hands back
 * the same live store proxy the committed read gives you, so the moment that
 * object escapes the callback its fields read committed values again. Only
 * primitives, and copies taken inside the callback, carry staged data out.
 * These slices return entities (`meta.get`, `panel.current`) whose fields
 * callers read later, and copying on every read would mint a new object
 * identity per call — which breaks the `createMemo` equality that keeps
 * `ContentRenderer` from remounting on unrelated commits. So the overlay
 * stays, and the framework draft is the right tool only where a guard can be
 * folded into the write it guards.
 */

import { getObserver } from "solid-js"

/**
 * A staged value is a DETACHED snapshot — a plain object, not the store proxy.
 * Handing one to a reader that is currently tracking silently costs it every
 * field-level subscription: `meta.get(id)?.content?.title` inside a memo would
 * subscribe to the `meta[id]` key and nothing else, so a later field patch,
 * which writes in place, would never wake it. That is a stale row, not a stale
 * read, and it lasts until something replaces the whole entry.
 *
 * Read-your-writes is an IMPERATIVE need — a handler that writes and then reads
 * back in the same task — and imperative code runs with no observer on the
 * stack. So the overlay applies exactly there, and a tracking reader always
 * gets the live store node. That is what keeps the wake granularity the slices
 * document, and what the "reads still touch the store first" note above is
 * actually promising.
 */
const trackingScope = () => getObserver() !== null

/** Marks a key deleted in the current task. */
export const STAGED_DELETE = Symbol("staged-delete")

export type StagedMap<V> = {
  /** Record a staged value (or STAGED_DELETE) for `key`. */
  stage(key: string, value: V | typeof STAGED_DELETE): void
  /** Staged value for `key`, else `committed`. Deletes read as undefined. */
  read(key: string, committed: V | undefined): V | undefined
  /** True when `key` has a staged entry in the current task. */
  has(key: string): boolean
  /**
   * `committed` entries with the overlay applied: staged values override,
   * staged deletes are dropped, staged additions appended.
   */
  entries(committed: Record<string, V | undefined>): Array<[string, V]>
}

export function createStagedMap<V>(): StagedMap<V> {
  let scratch: Map<string, V | typeof STAGED_DELETE> | undefined
  let clearQueued = false

  const queueClear = () => {
    if (clearQueued) return
    clearQueued = true
    queueMicrotask(() => {
      scratch = undefined
      clearQueued = false
    })
  }

  return {
    stage(key, value) {
      ;(scratch ??= new Map()).set(key, value)
      queueClear()
    },
    read(key, committed) {
      if (trackingScope()) return committed
      const pending = scratch?.get(key)
      if (pending === undefined) return committed
      return pending === STAGED_DELETE ? undefined : pending
    },
    has(key) {
      return scratch?.has(key) ?? false
    },
    entries(committed) {
      const merged = new Map<string, V | typeof STAGED_DELETE | undefined>(Object.entries(committed))
      if (scratch && !trackingScope()) for (const [key, value] of scratch) merged.set(key, value)
      const out: Array<[string, V]> = []
      for (const [key, value] of merged) {
        if (value === undefined || value === STAGED_DELETE) continue
        out.push([key, value as V])
      }
      return out
    },
  }
}

/** Single-value variant, for slices holding one object rather than a map. */
export type StagedValue<V> = {
  stage(value: V): void
  read(committed: V): V
}

export function createStagedValue<V>(): StagedValue<V> {
  let scratch: { value: V } | undefined
  let clearQueued = false
  return {
    stage(value) {
      scratch = { value }
      if (clearQueued) return
      clearQueued = true
      queueMicrotask(() => {
        scratch = undefined
        clearQueued = false
      })
    },
    read(committed) {
      if (trackingScope()) return committed
      return scratch ? scratch.value : committed
    },
  }
}
