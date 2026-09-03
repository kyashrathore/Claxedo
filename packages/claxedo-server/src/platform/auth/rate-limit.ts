/**
 * Control-plane abuse limiting: a per-isolate fixed-window fuse plus an
 * optional CROSS-ISOLATE shared store.
 *
 * ## Why a shared store at all
 *
 * `createFixedWindowConnectionRateLimiter` keeps buckets in a per-isolate
 * `Map`. Cloudflare runs many isolates per deployment, so the effective budget
 * was `configured × live isolates` — the limit LOOSENED exactly under the load
 * it exists to bound. `createLayeredRateLimiter` closes that by consulting a
 * shared store after the local fuse.
 *
 * ## DECISION: Cloudflare's native rate-limiting binding, not a counter DO
 *
 * Chosen: the native binding (`[[ratelimits]]` in wrangler.toml, `RateLimit`
 * API, `env.<NAME>.limit({ key })`).
 *
 * Verified against the Cloudflare docs on 2026-07-30 rather than assumed — and
 * the plan's own description was stale on two points worth recording:
 *   - The config block is `[[ratelimits]]`, NOT `[[unsafe.bindings]]`. The
 *     unsafe form was the beta shape; wrangler 4.114.0 (this package's pin)
 *     ships a first-class `ratelimits` key in its config schema.
 *   - `simple.period` accepts ONLY 10 or 60 (seconds), so the shared window is
 *     not a free parameter. The generated wrangler config pins 60 and
 *     `worker.ts` passes the matching `periodSeconds` to
 *     `cloudflareRateLimitStore`, which is also why
 *     `defaultRequestRateLimitWindowMs` must stay 60_000: both layers have to
 *     mean the same minute. `scripts/deploy/render-hosted-core-config.test.ts`
 *     asserts the pin.
 *
 * Why the binding beats a counter Durable Object here:
 *   - This is an ABUSE limiter, not accounting. Cloudflare documents the
 *     binding as "permissive, eventually consistent"; a flood still gets shut
 *     off, which is the whole requirement. Nobody is billed off these counters.
 *   - A DO adds a network round trip to EVERY request on the default
 *     middleware path (applied app-wide), plus a DO request charge
 *     per check. The binding's `limit()` is an on-machine cached counter.
 *   - A single counter DO per principal is a serialization point an attacker
 *     can aim at: flooding one key means flooding one DO, and the limiter
 *     becomes the bottleneck it was meant to protect.
 *
 * What we give up, stated plainly: the binding is per-Cloudflare-location, so a
 * distributed attacker spread across N colos gets `limit × N`. That is strictly
 * better than the status quo (`limit × isolates`, unbounded within one colo)
 * and is the documented, accepted trade for abuse limiting. If an exact global
 * budget is ever needed for a specific route (a billing-relevant quota, say),
 * that route can take a counter-DO `SharedRateLimitStore` implementation
 * without touching this interface — which is why the store is a port.
 *
 * ## Degrading on Node / self-host
 *
 * `hosted-node.ts` and `server.ts` have no Cloudflare bindings. `sharedStore`
 * is therefore optional everywhere: absent, `createLayeredRateLimiter` is the
 * in-memory fuse and nothing else. A single Node box has ONE process, so the
 * per-process fuse IS the global limit there — the degraded mode is correct for
 * that topology rather than merely tolerable. Multi-instance Node is a known
 * gap (see `docs/plans/2026-07-18-001`); it would need a real shared store.
 *
 * ## Relationship to `@claxedo/channels`' limiter
 *
 * `claxedo-channels/src/core/rate-limit.ts` has a SECOND, independent
 * implementation: `createSlidingWindowRateLimiter`, keyed by an opaque string
 * (`rateLimitKey(channel, externalUserId)`), LRU-capped, sliding rather than
 * fixed window. It is deliberately NOT merged into this file:
 *   - It limits inbound CHANNEL messages (Telegram/Slack senders), not HTTP
 *     requests, and runs after the access gate but before dedup/session/LLM.
 *   - `@claxedo/channels` is a standalone package; importing control-plane
 *     internals into it would invert the dependency direction.
 *
 * The reconciliation is at the STORE seam, not the limiter: `SharedRateLimitStore`
 * takes an opaque `key` string and returns a decision, which is exactly the
 * shape `createSlidingWindowRateLimiter.check(key)` already speaks. Channels can
 * adopt cross-isolate limiting later by accepting a `SharedRateLimitStore` and
 * consulting it after its own in-memory window — no signature change on either
 * side. Two window shapes (sliding vs fixed) over one shared store is fine: the
 * store enforces the ceiling, the local window shapes the burst.
 */

export type RateLimitResult = {
  allowed: true
} | {
  allowed: false
  retryAfterMs: number
  /**
   * True only for the FIRST rejection in the current window. Callers use this
   * to audit a flood once per window instead of amplifying every rejected
   * request into an audit write.
   */
  firstRejection?: boolean
}

/**
 * Cross-isolate rate-limit store: an opaque key in, an allow/deny out.
 *
 * Deliberately narrower than `ConnectionRateLimiter` — no refund, no size, no
 * structured principal. That is what makes it implementable by BOTH Cloudflare's
 * native binding (which accepts only `{ key }`) and, later, a counter DO or
 * `@claxedo/channels` (which already keys on an opaque string). Anything richer
 * would be unimplementable by the binding we chose.
 *
 * `check` is async because the binding's `limit()` is. Implementations must
 * never throw: a store that cannot answer has to fail OPEN (see
 * `cloudflareRateLimitStore`) so an outage in the limiter is not an outage in
 * the control plane. The local fuse is the floor that makes failing open safe.
 */
export type SharedRateLimitStore = {
  check(key: string): Promise<{ allowed: boolean }>
  /** Window length the store enforces, so callers can report `retryAfterMs`. */
  readonly periodSeconds: number
}

/** The `RateLimit` binding Cloudflare injects for a `[[ratelimits]]` block. */
export type CloudflareRateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

export type ConnectionRateLimiter = {
  check(input: {
    userId: string
    workspaceId: string
  }): RateLimitResult
  /**
   * Return one unit of budget for a request that did not actually consume the
   * limited resource (e.g. a provisioning poll that never minted a token).
   */
  refund?(input: {
    userId: string
    workspaceId: string
  }): void
  /** Number of live buckets (expired buckets are evicted). Observability/tests. */
  size?(): number
}

export function createFixedWindowConnectionRateLimiter(options: {
  limit?: number
  windowMs?: number
  now?: () => number
} = {}): ConnectionRateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number; rejections?: number }>()
  const limit = Math.max(1, options.limit ?? 6)
  const windowMs = Math.max(1, options.windowMs ?? 60_000)
  const now = options.now ?? Date.now
  let nextSweepAt = 0

  function evictExpired(timestamp: number) {
    if (timestamp < nextSweepAt) return
    nextSweepAt = timestamp + windowMs
    for (const [key, bucket] of buckets) {
      if (timestamp >= bucket.resetAt) buckets.delete(key)
    }
  }

  return {
    check(input) {
      const key = `${input.userId}:${input.workspaceId}`
      const timestamp = now()
      evictExpired(timestamp)
      const current = buckets.get(key)
      if (!current || timestamp >= current.resetAt) {
        buckets.set(key, { count: 1, resetAt: timestamp + windowMs })
        return { allowed: true }
      }
      if (current.count >= limit) {
        current.rejections = (current.rejections ?? 0) + 1
        return {
          allowed: false,
          retryAfterMs: current.resetAt - timestamp,
          firstRejection: current.rejections === 1,
        }
      }
      current.count += 1
      return { allowed: true }
    },
    refund(input) {
      const key = `${input.userId}:${input.workspaceId}`
      const current = buckets.get(key)
      if (!current || now() >= current.resetAt) return
      if (current.count > 0) current.count -= 1
    },
    size() {
      return buckets.size
    },
  }
}

/**
 * Adapt Cloudflare's `[[ratelimits]]` binding to `SharedRateLimitStore`.
 *
 * Fails OPEN on a thrown `limit()`. The binding is an availability dependency of
 * every request once the default middleware is app-wide; turning a
 * limiter blip into a 429 storm across the whole control plane trades a bounded
 * abuse window for a total outage. The in-memory fuse still holds the
 * per-isolate ceiling while the store is unavailable, so failing open degrades
 * to exactly the per-isolate behavior rather than to "no limit at all".
 */
export function cloudflareRateLimitStore(
  binding: CloudflareRateLimitBinding,
  options: { periodSeconds?: number } = {},
): SharedRateLimitStore {
  const periodSeconds = options.periodSeconds ?? 60
  return {
    periodSeconds,
    async check(key) {
      try {
        const result = await binding.limit({ key })
        return { allowed: result.success }
      } catch (err) {
        console.error("[claxedo-server] WARN  shared rate-limit store unavailable, failing open:", err)
        return { allowed: true }
      }
    },
  }
}

/**
 * The async limiter the default middleware uses: local fuse FIRST, shared store
 * second.
 *
 * Ordering is the point. The local `Map` check is free and catches the common
 * case (one isolate absorbing a flood), so the shared store — a real call, even
 * if a cheap one — is only consulted by traffic that already passed locally.
 * A rejection by either layer is a rejection: the effective limit is the
 * stricter of the two, never their sum.
 *
 * `refund` reaches only the local layer. The shared store has no refund
 * primitive (Cloudflare's binding exposes none), so a refunded request returns
 * local budget and leaves the shared counter spent. That is the conservative
 * direction — over-counting an abuse budget slightly is safe; under-counting is
 * the bug this workstream exists to fix.
 */
export type LayeredRateLimiter = {
  check(input: { key: string }): Promise<RateLimitResult>
  refund?(input: { key: string }): void
  /** True when a cross-isolate store is wired. Observability + tests. */
  readonly shared: boolean
}

export function createLayeredRateLimiter(options: {
  /** Per-isolate first-layer fuse. Required — it is the floor, not an add-on. */
  local: ConnectionRateLimiter
  /** Cross-isolate ceiling. Absent on Node/self-host; see the module header. */
  sharedStore?: SharedRateLimitStore
}): LayeredRateLimiter {
  const { local, sharedStore } = options
  return {
    shared: !!sharedStore,
    async check(input) {
      // The local limiter's key is structured (userId/workspaceId) for its nine
      // existing consumers; the layered path has one opaque key, so it rides in
      // `userId` with a constant `workspaceId`. Same bucket namespace either way.
      const localResult = local.check({ userId: input.key, workspaceId: "layered" })
      if (!localResult.allowed) return localResult
      if (!sharedStore) return localResult
      const shared = await sharedStore.check(input.key)
      if (shared.allowed) return { allowed: true }
      return { allowed: false, retryAfterMs: sharedStore.periodSeconds * 1000 }
    },
    refund(input) {
      local.refund?.({ userId: input.key, workspaceId: "layered" })
    },
  }
}
