/**
 * Per-isolate composition caching that never shares an unsettled instance.
 *
 * Workers build these compositions lazily inside the FIRST request, and Better
 * Auth's `$context` is a promise created at construction whose async
 * initialization runs on that request's I/O context. workerd retires a
 * request's I/O with the request, so when the constructing request is canceled
 * mid-initialization, the memoized promise can never settle — and every later
 * request in the isolate awaits it forever. Observed live 2026-08-31 on
 * staging: whole isolates where every Better Auth route (authorize, token,
 * revoke, userinfo, even the static discovery document) hung at ~3 ms CPU
 * until client disconnect, while non-auth routes answered instantly. That one
 * wedge propagated as the day's entire "stalled connection" defect family:
 * HTTP keep-alive pins a client to the wedged isolate, so pooled desktop
 * fetches and browsers alike appeared to have "poisoned connections" while
 * fresh connections that landed on healthy isolates worked.
 *
 * The rule this module enforces: a composition may be REUSED across requests
 * only after its initialization has settled successfully. Until then every
 * request builds its own instance — construction is cheap and synchronous, and
 * an instance whose init runs on the awaiting request's own context cannot be
 * wedged by someone else's cancellation. A failed init is never cached.
 */

export function settledCompositionCache<Key extends object, Value>(
  build: (key: Key) => Value,
  ready: (value: Value) => Promise<unknown>,
): (key: Key) => Value {
  const settled = new WeakMap<Key, { value: Value }>()
  return (key) => {
    const cached = settled.get(key)
    if (cached) return cached.value
    const value = build(key)
    ready(value).then(
      () => settled.set(key, { value }),
      () => {},
    )
    return value
  }
}
