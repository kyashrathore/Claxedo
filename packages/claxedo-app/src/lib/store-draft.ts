/**
 * Read a store the way its writer sees it: committed state plus everything
 * staged so far in the current task.
 *
 * Solid 2 stages store writes until the scheduler flushes. That is right for
 * rendering, but an imperative API whose methods a caller chains within one
 * task — set a field, then submit; set a secret, then check it — must observe
 * the writes that just happened.
 *
 * The write callback IS that context: the `$state` draft handed to
 * `setStore(($state) => ...)` reflects every write staged so far in the task,
 * across separate setter calls, including `storePath` writes, key deletes and
 * whole-object assignment. A callback that only reads stages nothing, so it
 * wakes no observers and schedules no commit work (~1.3us over a 2000-entry
 * record), which makes it a legitimate read primitive rather than a write in
 * disguise.
 *
 * TWO CONSTRAINTS, both verified in store-draft.test.ts:
 *
 * 1. IMPERATIVE CALLERS ONLY — never a computation. The reader reaches the
 *    draft through the store's own setter, and Solid 2's dev build rejects a
 *    setter call made with an owner on the stack
 *    (`REACTIVE_WRITE_IN_OWNED_SCOPE`). Inside a memo or an effect's compute
 *    that throw is swallowed: the compute-phase error is logged and the
 *    computation SKIPS THAT RUN, so the slice silently stops updating in dev
 *    while production (no guard, but also no subscription — the read is
 *    untracked) quietly renders a stale value. Both failure modes have the same
 *    cause and the same fix: call this from handlers and commands, and let
 *    components read the store.
 *
 * 2. A draft node that ESCAPES its callback is the same live store proxy the
 *    committed read returns, so its fields read committed values again. Only
 *    primitives, and copies taken inside the callback, carry staged data out.
 *    That is why slices returning entities (`meta.get`, `panel.current`) use the
 *    overlay in `@/lib/staged-reads` instead — copying per read would mint a new
 *    object identity every call and break the `createMemo` equality that keeps
 *    renderers from remounting on unrelated commits.
 *
 * Prefer folding a guard into the write it guards — `setStore($state => { if
 * ($state.panel.mode === mode) return; ... })` needs no reader at all. Reach for
 * this only where a value has to come back out to the caller.
 */

import type { StoreSetter } from "solid-js"

export type DraftReader<S> = <T>(read: (state: S) => T) => T

export function createDraftReader<S extends object>(setState: StoreSetter<S>): DraftReader<S> {
  return <T,>(read: (state: S) => T): T => {
    let out!: T
    setState(($state) => {
      out = read($state as S)
    })
    return out
  }
}
