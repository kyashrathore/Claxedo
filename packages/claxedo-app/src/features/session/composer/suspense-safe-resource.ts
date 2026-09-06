import type { Accessor } from "solid-js"

/**
 * Read a possibly-resource accessor without re-arming the enclosing `<Suspense>`.
 *
 * Reading a pending resource inside a tracked computation registers with the
 * nearest Suspense boundary, which swaps an already-rendered subtree back to
 * its fallback — the composer flickers away and back while a session opens.
 *
 * The guard belongs at the read, not at the hand-off: the suspension is armed
 * by the tracked computation that performs the read, so guarding here covers
 * every caller, including one that later passes a raw resource accessor.
 *
 * A plain accessor has no `state` and is read unchanged; only a resource is
 * gated. `refreshing` is deliberately readable: a value already exists, so the
 * read cannot suspend, and the previous list stays visible across a refetch
 * instead of blanking.
 *
 * While the list is loading the caller sees `undefined`, so the slash-command
 * popover shows no custom commands until it resolves — built-in commands and
 * typing are unaffected. That beats the composer disappearing, and beats
 * making the popover itself suspend or spin, which would only move the stall.
 */
export function readWithoutSuspending<T>(source: Accessor<T | undefined>): T | undefined {
  // Solid stamps `state` onto the resource accessor itself, so it is read off
  // the function with an `in` check rather than asserted into a Resource shape
  // the caller may not have handed us.
  const state = "state" in source ? source.state : undefined
  if (state !== undefined && state !== "ready" && state !== "refreshing") return undefined
  return source()
}
