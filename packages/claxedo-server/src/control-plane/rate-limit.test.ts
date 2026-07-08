import { describe, expect, test } from "vitest"
import { createFixedWindowConnectionRateLimiter } from "./rate-limit"

describe("fixed-window connection rate limiter", () => {
  test("limits within a window and resets after it", () => {
    let now = 0
    const limiter = createFixedWindowConnectionRateLimiter({ limit: 2, windowMs: 1_000, now: () => now })
    const key = { userId: "user_1", workspaceId: "ws_1" }

    expect(limiter.check(key)).toEqual({ allowed: true })
    expect(limiter.check(key)).toEqual({ allowed: true })
    expect(limiter.check(key)).toEqual({ allowed: false, retryAfterMs: 1_000, firstRejection: true })

    now = 1_001
    expect(limiter.check(key)).toEqual({ allowed: true })
  })

  test("marks only the FIRST rejection per window so floods audit once", () => {
    let now = 0
    const limiter = createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 1_000, now: () => now })
    const key = { userId: "user_1", workspaceId: "ws_1" }

    expect(limiter.check(key)).toEqual({ allowed: true })
    expect(limiter.check(key)).toEqual({ allowed: false, retryAfterMs: 1_000, firstRejection: true })
    expect(limiter.check(key)).toEqual({ allowed: false, retryAfterMs: 1_000, firstRejection: false })
    expect(limiter.check(key)).toEqual({ allowed: false, retryAfterMs: 1_000, firstRejection: false })

    // A refund mid-window restores budget but does NOT reset the rejection
    // marker: a later rejection in the same window still audits nothing.
    limiter.refund?.(key)
    expect(limiter.check(key)).toEqual({ allowed: true })
    expect(limiter.check(key)).toEqual({ allowed: false, retryAfterMs: 1_000, firstRejection: false })

    // A fresh window starts over.
    now = 1_001
    expect(limiter.check(key)).toEqual({ allowed: true })
    expect(limiter.check(key)).toEqual({ allowed: false, retryAfterMs: 1_000, firstRejection: true })
  })

  test("refund returns budget so a non-consuming request does not count", () => {
    const limiter = createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 })
    const key = { userId: "user_1", workspaceId: "ws_1" }

    expect(limiter.check(key)).toEqual({ allowed: true })
    limiter.refund?.(key)
    // The refunded slot is available again, repeatedly.
    expect(limiter.check(key)).toEqual({ allowed: true })
    limiter.refund?.(key)
    expect(limiter.check(key)).toEqual({ allowed: true })
    // Without a refund the next check is rejected.
    expect(limiter.check(key).allowed).toBe(false)
  })

  test("refund never grants extra budget beyond the cap", () => {
    const limiter = createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 })
    const key = { userId: "user_1", workspaceId: "ws_1" }

    // Refunding an untouched bucket is a no-op.
    limiter.refund?.(key)
    expect(limiter.check(key)).toEqual({ allowed: true })
    expect(limiter.check(key).allowed).toBe(false)
  })

  test("evicts expired buckets instead of accumulating one per key forever", () => {
    let now = 0
    const limiter = createFixedWindowConnectionRateLimiter({ limit: 5, windowMs: 1_000, now: () => now })

    for (let i = 0; i < 50; i++) {
      limiter.check({ userId: `user_${i}`, workspaceId: "ws_1" })
    }
    expect(limiter.size?.()).toBe(50)

    // After the window passes, the next check sweeps the expired buckets.
    now = 2_001
    limiter.check({ userId: "user_fresh", workspaceId: "ws_1" })
    expect(limiter.size?.()).toBe(1)
  })
})
