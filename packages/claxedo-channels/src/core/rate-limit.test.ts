import { describe, expect, test } from "vitest"
import { createSlidingWindowRateLimiter, rateLimitKey } from "./rate-limit"

describe("sliding window rate limiter", () => {
  test("allows up to the limit, then rejects with retry-after", () => {
    const rl = createSlidingWindowRateLimiter({ limit: 3, windowMs: 1000 })
    const k = rateLimitKey("telegram", "42")
    expect(rl.check(k, 0).allowed).toBe(true)
    expect(rl.check(k, 100).allowed).toBe(true)
    expect(rl.check(k, 200).allowed).toBe(true)
    const rejected = rl.check(k, 300)
    expect(rejected.allowed).toBe(false)
    if (!rejected.allowed) expect(rejected.retryAfterMs).toBe(700) // 0+1000-300
  })

  test("window slides — capacity returns as old events age out", () => {
    const rl = createSlidingWindowRateLimiter({ limit: 2, windowMs: 1000 })
    const k = rateLimitKey("telegram", "42")
    expect(rl.check(k, 0).allowed).toBe(true)
    expect(rl.check(k, 500).allowed).toBe(true)
    expect(rl.check(k, 600).allowed).toBe(false)
    // First event (t=0) leaves the window at t=1001.
    expect(rl.check(k, 1001).allowed).toBe(true)
  })

  test("keys are independent principals", () => {
    const rl = createSlidingWindowRateLimiter({ limit: 1, windowMs: 1000 })
    expect(rl.check(rateLimitKey("telegram", "a"), 0).allowed).toBe(true)
    expect(rl.check(rateLimitKey("telegram", "b"), 0).allowed).toBe(true)
    expect(rl.check(rateLimitKey("telegram", "a"), 0).allowed).toBe(false)
  })

  test("rejected attempts do not extend the penalty (no lockout ratchet)", () => {
    const rl = createSlidingWindowRateLimiter({ limit: 1, windowMs: 1000 })
    const k = rateLimitKey("telegram", "42")
    expect(rl.check(k, 0).allowed).toBe(true)
    expect(rl.check(k, 100).allowed).toBe(false)
    expect(rl.check(k, 500).allowed).toBe(false)
    // Only the accepted event at t=0 counts; capacity returns at t=1001.
    expect(rl.check(k, 1001).allowed).toBe(true)
  })

  test("evicts oldest keys past the cap (memory guard)", () => {
    const rl = createSlidingWindowRateLimiter({ limit: 5, windowMs: 100_000, maxKeys: 2 })
    rl.check("a", 0)
    rl.check("b", 0)
    rl.check("c", 0) // evicts "a"
    // "a" was evicted, so it starts fresh (full capacity) rather than remembering.
    expect(rl.check("a", 0).allowed).toBe(true)
  })
})
