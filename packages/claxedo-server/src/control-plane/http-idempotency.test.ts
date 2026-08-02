import { describe, expect, test, vi } from "vitest"
import {
  cachedIdempotency,
  IdempotencyCapacityError,
  IdempotencyConflictError,
  idempotencyCacheKey,
  parseIdempotencyKey,
} from "./http-idempotency"

/**
 * A fresh module instance, i.e. an isolate with an empty cache. The cache lives
 * in module scope, so tests that fill it to capacity would otherwise leak that
 * state into whatever runs next.
 */
async function freshModule() {
  vi.resetModules()
  return import("./http-idempotency")
}

describe("control-plane HTTP idempotency", () => {
  test("coalesces concurrent requests and retries after a failed attempt", async () => {
    const deferred = Promise.withResolvers<string>()
    const run = vi.fn(() => deferred.promise)

    const first = cachedIdempotency("coalesce", run)
    const second = cachedIdempotency("coalesce", run)
    deferred.resolve("done")

    await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"])
    expect(run).toHaveBeenCalledTimes(1)

    await expect(cachedIdempotency("retry-after-failure", async () => {
      throw new Error("unavailable")
    })).rejects.toThrow("unavailable")
    await expect(cachedIdempotency("retry-after-failure", async () => "recovered"))
      .resolves.toBe("recovered")
  })

  test("expires cached results and bounds distinct keys", async () => {
    vi.useFakeTimers()
    try {
      const expiring = vi.fn(async () => "value")
      await cachedIdempotency("expires", expiring)
      await cachedIdempotency("expires", expiring)
      expect(expiring).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(5 * 60_000 + 1)
      await cachedIdempotency("expires", expiring)
      expect(expiring).toHaveBeenCalledTimes(2)

      const first = vi.fn(async () => "first")
      await cachedIdempotency("bounded:0", first)
      await Promise.all(
        Array.from({ length: 1_000 }, (_, index) =>
          cachedIdempotency(`bounded:${index + 1}`, async () => index)),
      )
      await cachedIdempotency("bounded:0", first)
      expect(first).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test("coalesces pending work within the in-flight window, then stops waiting on it", async () => {
    // W4.2 changed this deliberately. In-flight entries used to carry NO
    // expiry, which made them unsweepable: one hung `run` held its slot until
    // the isolate died. They now carry a deadline like any other entry.
    //
    // The trade is the same one the cron lease makes: past the deadline the
    // holder is presumed dead, so a later caller may proceed. Cross-isolate
    // duplicate execution is prevented by the DURABLE layer
    // (`http-idempotency.durable.test.ts`), not by an unbounded local wait.
    //
    // Fresh module instance: the cache is module-scope, and the capacity tests
    // in this file leave it near its ceiling. Sharing it would make this test's
    // result depend on file order.
    const mod = await freshModule()
    vi.useFakeTimers()
    try {
      const deferred = Promise.withResolvers<string>()
      const run = vi.fn(() => deferred.promise)

      const first = mod.cachedIdempotency("pending-ttl", run)
      // `run` is invoked off a microtask, so let it start before counting.
      await Promise.resolve()
      // Well inside the in-flight window: still coalesced onto one execution.
      vi.advanceTimersByTime(mod.IDEMPOTENCY_INFLIGHT_TTL_MS - 1)
      const second = mod.cachedIdempotency("pending-ttl", run)
      expect(run).toHaveBeenCalledTimes(1)

      // Past it, the entry is collectable and a fresh caller proceeds rather
      // than chaining onto work that may never settle.
      vi.advanceTimersByTime(2)
      await expect(mod.cachedIdempotency("pending-ttl", async () => "recovered")).resolves.toBe("recovered")

      deferred.resolve("done")
      await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"])
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("a cache saturated with hung requests recovers instead of wedging into permanent 503s", async () => {
    // The other half of the same latent bug, and the one with the worse blast
    // radius. In-flight entries had no `expiresAt`, and the sweep skips entries
    // without one, so 1,000 hung requests filled the cache with slots that could
    // never be collected: every subsequent key got a 503 until the isolate was
    // replaced.
    //
    // Shedding load AT capacity is correct and stays (see the pending-capacity
    // test below). What must not happen is never recovering from it.
    const mod = await freshModule()
    vi.useFakeTimers()
    try {
      const hung = Array.from({ length: 1_000 }, () => Promise.withResolvers<number>())
      const pending = hung.map((deferred, index) =>
        mod.cachedIdempotency(`wedged:${index}`, () => deferred.promise))
      await Promise.resolve()

      // At capacity: new work is refused, as designed.
      await expect(mod.cachedIdempotency("wedged:overflow", async () => "served"))
        .rejects.toBeInstanceOf(mod.IdempotencyCapacityError)

      // Pre-fix, this stayed a 503 for the life of the isolate. The hung
      // entries now age out and capacity recovers on its own.
      vi.advanceTimersByTime(mod.IDEMPOTENCY_INFLIGHT_TTL_MS + 1)
      await expect(mod.cachedIdempotency("wedged:recovered", async () => "served")).resolves.toBe("served")

      hung.forEach((deferred) => deferred.resolve(0))
      await Promise.all(pending)
    } finally {
      vi.useRealTimers()
    }
  })

  test("rejects new distinct work at pending capacity without evicting an existing key", async () => {
    const pending = Array.from({ length: 1_000 }, () => Promise.withResolvers<number>())
    const runs = pending.map((deferred, index) => vi.fn(() => deferred.promise.then(() => index)))
    const promises = runs.map((run, index) => cachedIdempotency(`pending-pressure:${index}`, run))
    await Promise.resolve()

    const overflow = vi.fn(async () => "overflow")
    await expect(cachedIdempotency("pending-pressure:overflow", overflow))
      .rejects.toBeInstanceOf(IdempotencyCapacityError)
    const duplicate = cachedIdempotency("pending-pressure:0", runs[0])

    expect(overflow).not.toHaveBeenCalled()
    expect(runs[0]).toHaveBeenCalledTimes(1)

    pending.forEach((deferred) => deferred.resolve(0))
    await expect(Promise.all([...promises, duplicate])).resolves.toHaveLength(1_001)
  })

  test("validates raw keys and isolates cache entries by authenticated principal", async () => {
    expect(parseIdempotencyKey("k".repeat(256))).toHaveLength(256)
    expect(() => parseIdempotencyKey("k".repeat(257))).toThrow("at most 256 characters")
    expect(() => parseIdempotencyKey(" ".repeat(257))).toThrow("at most 256 characters")

    const run = vi.fn(async () => "done")
    const firstPrincipal = idempotencyCacheKey({
      operation: "register",
      principal: "signed:issuer|user_1",
      workspaceId: "ws_1",
      sessionId: "session_1",
      key: "request_1",
    })
    const secondPrincipal = idempotencyCacheKey({
      operation: "register",
      principal: "signed:issuer|user_2",
      workspaceId: "ws_1",
      sessionId: "session_1",
      key: "request_1",
    })

    await cachedIdempotency(firstPrincipal, run)
    await cachedIdempotency(firstPrincipal, run)
    await cachedIdempotency(secondPrincipal, run)

    expect(firstPrincipal).not.toBe(secondPrincipal)
    expect(run).toHaveBeenCalledTimes(2)
  })

  test("rejects reuse of an idempotency key with a different payload", async () => {
    const run = vi.fn(async () => "done")
    await expect(cachedIdempotency("payload-binding", run, "[1]")).resolves.toBe("done")
    await expect(cachedIdempotency("payload-binding", run, "[2]"))
      .rejects.toBeInstanceOf(IdempotencyConflictError)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
