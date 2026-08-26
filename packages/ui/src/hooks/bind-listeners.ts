/**
 * Bind DOM listeners from a scope that owns its own cleanup.
 *
 * A `createEffect` effect phase, `createTrackedEffect` and `onSettled` all take
 * their cleanup from what the callback RETURNS, so
 * `@solid-primitives/event-listener`'s `makeEventListener` — which registers its
 * own `onCleanup` internally — is unusable in any of them. The effect phase runs
 * with no owner, so that `onCleanup` only warns (`[NO_OWNER_CLEANUP]`) and the
 * listener is never removed. The tracked scopes are worse: they run with
 * `CONFIG_CHILDREN_FORBIDDEN`, so Solid 2 throws `[CLEANUP_IN_FORBIDDEN_SCOPE]`
 * before `makeEventListener` returns its clear function, and the throw is not
 * contained — it escapes the effect uncaught, which HALTS the whole reactive
 * system (`REACTIVITY_HALTED`): one popover open and nothing in the app updates
 * again.
 *
 * This binds the listeners directly and returns the matching unbind, which is
 * exactly the shape those scopes ask for:
 *
 * ```ts
 * createEffect(open, (isOpen) => {
 *   if (!isOpen) return
 *   return bindListeners([window, "keydown", onKeyDown, { capture: true }])
 * })
 * ```
 *
 * In a scope that DOES allow cleanup registration — a component body —
 * `makeEventListener` remains the right call.
 */
export type ListenerBinding = readonly [
  target: EventTarget,
  type: string,
  /**
   * Handlers are written against their concrete event type
   * (`(event: KeyboardEvent) => void`), while `addEventListener` wants the
   * contravariant `(event: Event) => void`. `never` accepts both, so the one
   * cast lives here instead of at every call site.
   */
  handler: (event: never) => void,
  options?: AddEventListenerOptions,
]

export function bindListeners(...bindings: ListenerBinding[]): () => void {
  for (const [target, type, handler, options] of bindings) {
    target.addEventListener(type, handler as EventListener, options)
  }
  return () => {
    for (const [target, type, handler, options] of bindings) {
      target.removeEventListener(type, handler as EventListener, options)
    }
  }
}
