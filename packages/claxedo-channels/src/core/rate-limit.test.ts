import { describe, expect, test } from "vitest"
import {
  createChannelCore,
  createMemoryDedupStore,
  createMemorySessionResolver,
  createSlidingWindowRateLimiter,
  rateLimitKey,
  type ChannelRuntime,
  type InboundEnvelope,
} from "../index"

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

  test("a future `now` empties the window — why the core must not pass sender-claimed time", () => {
    const rl = createSlidingWindowRateLimiter({ limit: 3, windowMs: 60_000 })
    const k = rateLimitKey("telegram", "42")
    expect(rl.check(k, 0).allowed).toBe(true)
    expect(rl.check(k, 0).allowed).toBe(true)
    expect(rl.check(k, 0).allowed).toBe(true)
    expect(rl.check(k, 0).allowed).toBe(false)
    // Jumping the clock forward ages out every recorded hit and restores full
    // capacity. That is correct for a sliding window driven by a TRUSTED clock,
    // and it is exactly why `now` must never come from the sender.
    expect(rl.check(k, 10 * 60_000).allowed).toBe(true)
  })
})

describe("core rate limit is driven by the server clock, not the envelope", () => {
  function runtime(): ChannelRuntime & { sent: string[] } {
    const sent: string[] = []
    return {
      sent,
      async createSession() {
        return { sessionId: "ses_1", appUrl: "/s/ses_1" }
      },
      async *sendMessage(input) {
        sent.push(input.text)
        yield { type: "finish", sessionId: input.sessionId }
      },
      async abortSession() {
        return { ok: true, status: "cancelled" }
      },
    }
  }

  test("a forged future receivedAt does NOT buy a fresh budget", async () => {
    const rt = runtime()
    const denials: string[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      rateLimiter: createSlidingWindowRateLimiter({ limit: 2, windowMs: 60_000 }),
      onDenial: (_envelope, reason) => {
        denials.push(reason)
      },
    })

    // Each delivery claims a time further into the future than the last. A
    // limiter fed `receivedAt` would age out the previous hits every time and
    // let all three through; on the server clock all three land in one window.
    const send = (index: number) =>
      core.handleInbound({
        channel: "telegram",
        externalUserId: "flooder",
        threadKey: "telegram:install:chat:thread",
        idempotencyKey: `delivery-${index}`,
        text: `flood ${index}`,
        receivedAt: Date.now() + index * 10 * 60_000,
        chatType: "dm",
        raw: {},
      } satisfies InboundEnvelope, { reply() {} })

    await send(0)
    await send(1)
    await send(2)

    expect(denials).toEqual(["rate_limited"])
    expect(rt.sent).toEqual(["flood 0", "flood 1"])
  })
})
