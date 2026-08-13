import type { Accessor, Resource } from "solid-js"

/**
 * Read a possibly-resource accessor WITHOUT re-arming the enclosing `<Suspense>`.
 *
 * Reading a PENDING resource inside a tracked computation registers with the
 * nearest Suspense boundary, which swaps an ALREADY RENDERED subtree back to its
 * fallback. Measured on cold open: the composer rendered at ~35 ms, the
 * slash-command list resource was first read by a lazily-evaluated memo at
 * ~68 ms while still in flight, and the whole composer region vanished behind
 * `session-prompt-dock-loading` for 75-83 ms — 37% of the metric — before the
 * SAME DOM node was reattached. The user sees the composer appear, disappear,
 * and reappear while a session opens.
 *
 * This belongs at the READ, not at the hand-off. The suspension is armed by the
 * tracked computation that performs the read, so guarding here makes that memo
 * safe for EVERY caller — including a future one that passes a raw resource
 * accessor, which is exactly how this defect was introduced.
 *
 * A plain accessor has no `state` and is read unchanged; only a resource is
 * gated. `refreshing` is deliberately readable: a value already exists, so the
 * read cannot suspend, and the previous list stays visible across a refetch
 * instead of blanking.
 *
 * SEMANTIC CONSEQUENCE, stated rather than smuggled: while the list is loading
 * the caller sees `undefined`, so the slash-command popover shows no CUSTOM
 * commands and they appear when it resolves. Built-in commands are unaffected
 * and the user can type throughout. That is strictly better than the composer
 * disappearing, and better than making the popover itself suspend or spin,
 * which would only move the stall.
 */
export function readWithoutSuspending<T>(source: Accessor<T | undefined>): T | undefined {
  const state = (source as Partial<Resource<T>>).state
  if (state !== undefined && state !== "ready" && state !== "refreshing") return undefined
  return source()
}
