/**
 * W3 acceptance: the rate limit is enforced GLOBALLY across isolates, not
 * per-isolate.
 *
 * The bug this proves fixed: bucket state lived in a per-isolate `Map`, so N
 * live isolates each granted the full budget and the effective limit was
 * `configured x N` — the limiter loosened exactly under the load it exists to
 * bound. Cloudflare gives no control over isolate count, so this is not a tuning
 * problem; it needs a store outside the isolate.
 *
 * How two isolates are simulated: an isolate's limiter identity IS its `Map`, so
 * two independently-constructed `createLayeredRateLimiter` instances are two
 * isolates by construction. Both are handed the SAME `SharedRateLimitStore`,
 * which is what a Cloudflare rate-limit binding is across isolates.
 *
 * Every global-limit test here carries its POSITIVE CONTROL in the same test:
 * the identical request sequence is replayed with the shared store DISABLED and
 * asserted to leak ~2x. Without that, a green "global limit held" could just as
 * easily be a limit nothing was testing.
 */

import { describe, expect, test, vi } from "vitest"
import {
  cloudflareRateLimitStore,
  createFixedWindowConnectionRateLimiter,
  createLayeredRateLimiter,
  type CloudflareRateLimitBinding,
  type SharedRateLimitStore,
} from "./rate-limit"

/**
 * An in-memory stand-in for the Cloudflare `[[ratelimits]]` binding: one counter
 * per key, shared by every isolate holding a reference. Fixed-window like the
 * real binding, and deliberately NOT time-based — the tests drive request counts,
 * not clocks, so a wall-clock window would make them flaky for no coverage gain.
 */
function fakeSharedStore(limit: number): SharedRateLimitStore & { calls: number } {
  const counts = new Map<string, number>()
  return {
    periodSeconds: 60,
    calls: 0,
    async check(key) {
      this.calls += 1
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      return { allowed: next <= limit }
    },
  }
}

/** One "isolate": its own in-memory fuse, optionally sharing a store. */
function isolate(input: { localLimit: number; sharedStore?: SharedRateLimitStore }) {
  return createLayeredRateLimiter({
    local: createFixedWindowConnectionRateLimiter({ limit: input.localLimit, windowMs: 60_000 }),
    ...(input.sharedStore ? { sharedStore: input.sharedStore } : {}),
  })
}

/** Round-robin `total` requests for one key across the given isolates. */
async function drive(
  limiters: ReturnType<typeof isolate>[],
  input: { key: string; total: number },
) {
  let allowed = 0
  let rejected = 0
  for (let i = 0; i < input.total; i += 1) {
    const result = await limiters[i % limiters.length]!.check({ key: input.key })
    if (result.allowed) allowed += 1
    else rejected += 1
  }
  return { allowed, rejected }
}

describe("W3.1 shared-store rate limiting across isolates", () => {
  test("two isolates sharing a store enforce the GLOBAL limit, not 2x", async () => {
    const GLOBAL_LIMIT = 20
    // Local fuse deliberately LOOSER than the global limit: this test must prove
    // the shared store is what binds. A local limit of 10 per isolate would cap
    // the total at 20 by accident and the test would pass with no store at all.
    const LOCAL_FUSE = 1_000
    const store = fakeSharedStore(GLOBAL_LIMIT)

    const shared = await drive([isolate({ localLimit: LOCAL_FUSE, sharedStore: store }), isolate({ localLimit: LOCAL_FUSE, sharedStore: store })], {
      key: "203.0.113.7",
      total: 100,
    })

    expect(shared.allowed).toBe(GLOBAL_LIMIT)
    expect(shared.rejected).toBe(80)

    // ── POSITIVE CONTROL: same sequence, shared store disabled ───────────────
    // This is the pre-W3 code path. If it did NOT leak, the assertion above
    // would be proving nothing about the store.
    const leaked = await drive([isolate({ localLimit: GLOBAL_LIMIT }), isolate({ localLimit: GLOBAL_LIMIT })], {
      key: "203.0.113.7",
      total: 100,
    })

    expect(leaked.allowed).toBe(GLOBAL_LIMIT * 2)
    expect(leaked.allowed).toBeGreaterThan(shared.allowed)
  })

  test("leakage scales with isolate count — eight isolates leak 8x without the store", async () => {
    // The finding is `configured x live isolates`, so the control has to show the
    // MULTIPLIER, not just "two is more than one". Cloudflare gives no ceiling on
    // isolate count, which is why the per-isolate design has no bounded failure.
    const GLOBAL_LIMIT = 5
    const store = fakeSharedStore(GLOBAL_LIMIT)
    const eight = () => Array.from({ length: 8 }, () => isolate({ localLimit: GLOBAL_LIMIT, sharedStore: store }))

    const shared = await drive(eight(), { key: "flood", total: 400 })
    expect(shared.allowed).toBe(GLOBAL_LIMIT)

    const leaked = await drive(
      Array.from({ length: 8 }, () => isolate({ localLimit: GLOBAL_LIMIT })),
      { key: "flood", total: 400 },
    )
    expect(leaked.allowed).toBe(GLOBAL_LIMIT * 8)
  })

  test("distinct keys get independent global budgets", async () => {
    // A shared store must not become a shared BUCKET: one abusive client
    // exhausting a global counter that everyone shares would be a trivially
    // triggerable denial of service on the whole control plane.
    const store = fakeSharedStore(3)
    const limiters = [isolate({ localLimit: 100, sharedStore: store }), isolate({ localLimit: 100, sharedStore: store })]

    const first = await drive(limiters, { key: "client-a", total: 10 })
    const second = await drive(limiters, { key: "client-b", total: 10 })

    expect(first.allowed).toBe(3)
    expect(second.allowed).toBe(3)
  })

  test("the local fuse short-circuits before the shared store is consulted", async () => {
    // W3.4's whole point: the free per-isolate check absorbs a flood so the
    // shared call is only paid by traffic that already passed locally. If the
    // ordering inverted, every request in a flood would cost a store call.
    const store = fakeSharedStore(1_000)
    const limiter = isolate({ localLimit: 2, sharedStore: store })

    const result = await drive([limiter], { key: "burst", total: 50 })

    expect(result.allowed).toBe(2)
    // 2 admitted requests reached the store; the other 48 were stopped locally.
    expect(store.calls).toBe(2)
  })

  test("either layer alone can reject — the effective limit is the stricter one", async () => {
    // Local stricter than shared.
    const looseStore = fakeSharedStore(1_000)
    const localBound = await drive([isolate({ localLimit: 4, sharedStore: looseStore })], { key: "k", total: 20 })
    expect(localBound.allowed).toBe(4)

    // Shared stricter than local.
    const tightStore = fakeSharedStore(4)
    const sharedBound = await drive([isolate({ localLimit: 1_000, sharedStore: tightStore })], { key: "k", total: 20 })
    expect(sharedBound.allowed).toBe(4)
  })

  test("a rejection from the shared store reports the store's own window", async () => {
    const store = fakeSharedStore(1)
    const limiter = isolate({ localLimit: 1_000, sharedStore: store })

    await limiter.check({ key: "k" })
    const rejected = await limiter.check({ key: "k" })

    expect(rejected.allowed).toBe(false)
    if (rejected.allowed) throw new Error("unreachable")
    // Callers set Retry-After from this; a 0 would tell a client to retry now.
    expect(rejected.retryAfterMs).toBe(60_000)
  })
})

describe("W3.1 Node/self-host degradation", () => {
  test("with no shared store the limiter is the in-memory fuse and stays enforcing", async () => {
    // hosted-node.ts / server.ts have no Cloudflare bindings. Absent a store the
    // limiter must still LIMIT — degrading to "no limit" would turn the
    // self-host composition into the unbounded surface.
    const limiter = isolate({ localLimit: 3 })
    expect(limiter.shared).toBe(false)

    const result = await drive([limiter], { key: "k", total: 10 })
    expect(result.allowed).toBe(3)
    expect(result.rejected).toBe(7)
  })
})

describe("W3.1 Cloudflare binding adapter", () => {
  test("maps the binding's success flag onto an allow/deny decision", async () => {
    const binding: CloudflareRateLimitBinding = {
      limit: vi.fn(async ({ key }) => ({ success: key === "good" })),
    }
    const store = cloudflareRateLimitStore(binding)

    await expect(store.check("good")).resolves.toEqual({ allowed: true })
    await expect(store.check("bad")).resolves.toEqual({ allowed: false })
    expect(binding.limit).toHaveBeenCalledWith({ key: "bad" })
  })

  test("fails OPEN when the binding throws, leaving the local fuse in charge", async () => {
    // Once the default guard is app-wide, the store is on the path of every
    // request. Turning a limiter blip into a 429 storm across the whole control
    // plane trades a bounded abuse window for a total outage.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const binding: CloudflareRateLimitBinding = {
      limit: vi.fn(async () => {
        throw new Error("rate limiter unavailable")
      }),
    }
    const store = cloudflareRateLimitStore(binding)

    await expect(store.check("k")).resolves.toEqual({ allowed: true })
    // Silent fail-open is indistinguishable from "no attack"; it must be visible.
    expect(consoleError).toHaveBeenCalled()

    // And the fuse still bounds the request rate while the store is down, so
    // failing open degrades to the pre-W3 ceiling, not to no ceiling.
    const limiter = isolate({ localLimit: 2, sharedStore: store })
    const result = await drive([limiter], { key: "k", total: 10 })
    expect(result.allowed).toBe(2)

    consoleError.mockRestore()
  })

  test("period defaults to the 60s the wrangler binding declares", () => {
    expect(cloudflareRateLimitStore({ limit: async () => ({ success: true }) }).periodSeconds).toBe(60)
  })
})
