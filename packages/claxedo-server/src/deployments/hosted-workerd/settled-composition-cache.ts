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
 *
 * The readiness reads outlive most responses (the auth descriptor answers in
 * 2 ms of Worker time; the reads take two database rounds), and the runtime
 * cancels an async call that is neither awaited nor passed to
 * `ctx.waitUntil()` once the invocation ends
 * (developers.cloudflare.com/workers/runtime-apis/context/#waituntil).
 * Without the composing request's `waitUntil` the readiness settles only when
 * the isolate happens to hold a long-lived stream, and every other request
 * composes again at 16–48 ms CPU. `waitUntil` keeps it running up to 30 s past
 * the response or the client's disconnect; a request that has none (a Durable
 * Object's) still gets its own instance.
 */

import { mark } from "../../platform/http/server-timing"

/** What a request can keep running past its response: `ExecutionContext.waitUntil`. */
export type CompositionLifetime = { waitUntil(promise: Promise<unknown>): void }

export function settledCompositionCache<Key extends object, Value>(
  build: (key: Key) => Value,
  ready: (value: Value) => Promise<unknown>,
): (key: Key, lifetime?: CompositionLifetime) => Value {
  const settled = new WeakMap<Key, { value: Value }>()
  return (key, lifetime) => {
    const cached = settled.get(key)
    if (cached) return cached.value
    mark("compose")
    const value = build(key)
    const settling = ready(value).then(
      () => settled.set(key, { value }),
      () => {},
    )
    lifetime?.waitUntil(settling)
    return value
  }
}
