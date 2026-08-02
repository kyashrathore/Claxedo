/**
 * W4.2 acceptance: a duplicate register/checkpoint across TWO isolates executes
 * the operation ONCE.
 *
 * ## How two isolates are simulated
 *
 * `http-idempotency.ts` keeps its fast-path cache in module-scope `Map`s, so an
 * isolate's identity IS that module instance. Two isolates are therefore two
 * independent `import()`s of the module under `vi.resetModules()` — not two
 * objects from one factory, which would share the maps and prove nothing. Both
 * are handed the SAME fake Convex store, which is what one Convex deployment is
 * across isolates.
 *
 * This mirrors the two-isolate construction `rate-limit.shared-store.test.ts`
 * uses for W3.
 *
 * ## Positive control
 *
 * Every cross-isolate test replays the identical sequence with the durable store
 * ABSENT and asserts the operation runs TWICE. Without that control, a green
 * "ran once" could be a test where the second isolate was never really separate.
 */

import { beforeEach, describe, expect, test, vi } from "vitest"
import type { DurableIdempotencyStore } from "./http-idempotency"

type IdempotencyModule = typeof import("./http-idempotency")

/** A fresh module instance = a fresh isolate, with its own per-isolate maps. */
async function isolate(store?: DurableIdempotencyStore): Promise<IdempotencyModule> {
  vi.resetModules()
  const mod = await import("./http-idempotency")
  if (store) mod.setDurableIdempotencyStore(store)
  return mod
}

/**
 * An in-memory stand-in for `convex/idempotency.ts`, implementing the same
 * begin/complete/release contract: one row per cache key, shared by every
 * isolate holding a reference. Clock-driven so lease expiry is testable without
 * sleeping.
 */
function fakeConvexStore(clock = { now: 1_000 }) {
  const rows = new Map<string, {
    fingerprint: string
    state: "in_flight" | "completed"
    leaseExpiresAt: number
    expiresAt: number
    resultJson?: string
  }>()
  const leaseMs = 60_000
  const resultTtlMs = 5 * 60_000
  const store: DurableIdempotencyStore & { rows: typeof rows; clock: typeof clock } = {
    rows,
    clock,
    async begin({ cacheKey, fingerprint }) {
      const existing = rows.get(cacheKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) return { state: "conflict" }
        if (existing.state === "completed" && existing.expiresAt > clock.now) {
          return {
            state: "completed",
            ...(existing.resultJson === undefined ? {} : { resultJson: existing.resultJson }),
          }
        }
        if (existing.state === "in_flight" && existing.leaseExpiresAt > clock.now) {
          return { state: "in_flight" }
        }
      }
      rows.set(cacheKey, {
        fingerprint,
        state: "in_flight",
        leaseExpiresAt: clock.now + leaseMs,
        expiresAt: clock.now + leaseMs,
      })
      return { state: "acquired" }
    },
    async complete({ cacheKey, fingerprint, resultJson }) {
      const existing = rows.get(cacheKey)
      if (!existing || existing.fingerprint !== fingerprint) return
      rows.set(cacheKey, {
        ...existing,
        state: "completed",
        ...(resultJson === undefined ? {} : { resultJson }),
        leaseExpiresAt: 0,
        expiresAt: clock.now + resultTtlMs,
      })
    },
    async release({ cacheKey, fingerprint }) {
      const existing = rows.get(cacheKey)
      if (!existing || existing.fingerprint !== fingerprint) return
      if (existing.state === "completed") return
      rows.delete(cacheKey)
    },
  }
  return store
}

function registerKey(mod: IdempotencyModule, key: string) {
  return mod.idempotencyCacheKey({
    operation: "register",
    principal: "signed:issuer|user_1",
    workspaceId: "ws_1",
    sessionId: "session_1",
    key,
  })
}

describe("W4.2 durable idempotency across isolates", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  test("a duplicate register across two isolates executes ONCE", async () => {
    const store = fakeConvexStore()
    const run = vi.fn(async () => ({ ok: true, session: "s_1" }))

    const first = await isolate(store)
    const second = await isolate(store)
    const key = registerKey(first, "request_1")

    const a = await first.cachedIdempotency(key, run, "fp")
    const b = await second.cachedIdempotency(key, run, "fp")

    expect(run).toHaveBeenCalledTimes(1)
    // The second isolate did not merely skip the work — it returned the SAME
    // response, replayed from the durable receipt.
    expect(a).toEqual({ ok: true, session: "s_1" })
    expect(b).toEqual({ ok: true, session: "s_1" })

    // POSITIVE CONTROL: identical sequence, no durable store. Two isolates each
    // execute it — the pre-fix behavior, and proof the isolates are really
    // separate rather than sharing a cache.
    const leaky = vi.fn(async () => ({ ok: true, session: "s_1" }))
    const thirdIsolate = await isolate()
    const fourthIsolate = await isolate()
    await thirdIsolate.cachedIdempotency(key, leaky, "fp")
    await fourthIsolate.cachedIdempotency(key, leaky, "fp")
    expect(leaky).toHaveBeenCalledTimes(2)
  })

  test("a duplicate checkpoint across two isolates executes ONCE", async () => {
    const store = fakeConvexStore()
    const run = vi.fn(async () => ({ ok: true, maxEventOrdinal: 7 }))

    const first = await isolate(store)
    const second = await isolate(store)
    const key = first.idempotencyCacheKey({
      operation: "checkpoint",
      principal: "signed:issuer|user_1",
      workspaceId: "ws_1",
      sessionId: "session_1",
      key: "request_2",
    })

    await first.cachedIdempotency(key, run, "fp")
    await expect(second.cachedIdempotency(key, run, "fp")).resolves.toEqual({ ok: true, maxEventOrdinal: 7 })
    expect(run).toHaveBeenCalledTimes(1)

    // POSITIVE CONTROL: no durable store, same two-isolate sequence.
    const leaky = vi.fn(async () => ({ ok: true, maxEventOrdinal: 7 }))
    await (await isolate()).cachedIdempotency(key, leaky, "fp")
    await (await isolate()).cachedIdempotency(key, leaky, "fp")
    expect(leaky).toHaveBeenCalledTimes(2)
  })

  test("a second isolate arriving mid-operation gets 409 rather than re-executing", async () => {
    // The dangerous window: isolate A is still running (or timed out without
    // being cancelled) when the client's retry lands on isolate B.
    const store = fakeConvexStore()
    const deferred = Promise.withResolvers<{ ok: true }>()
    const run = vi.fn(() => deferred.promise)

    const first = await isolate(store)
    const second = await isolate(store)
    const key = registerKey(first, "request_3")

    const pending = first.cachedIdempotency(key, run, "fp")
    const second409 = second.cachedIdempotency(key, run, "fp")

    await expect(second409).rejects.toMatchObject({
      status: 409,
      code: "control_plane_idempotency_in_flight",
    })
    expect(run).toHaveBeenCalledTimes(1)

    deferred.resolve({ ok: true })
    await expect(pending).resolves.toEqual({ ok: true })
  })

  test("a dead isolate's claim expires so the operation is not stranded", async () => {
    // A lease that never expired would turn one crashed isolate into a key that
    // can never be run again — strictly worse than the duplicate it prevents.
    const clock = { now: 1_000 }
    const store = fakeConvexStore(clock)
    const first = await isolate(store)
    const key = registerKey(first, "request_4")

    // Isolate A claims and then dies: its promise never settles.
    const abandoned = vi.fn(() => new Promise<never>(() => {}))
    void first.cachedIdempotency(key, abandoned, "fp")
    await vi.waitFor(() => expect(store.rows.get(key!)?.state).toBe("in_flight"))

    // Before expiry, a fresh isolate is correctly refused.
    const second = await isolate(store)
    await expect(second.cachedIdempotency(key, vi.fn(), "fp")).rejects.toMatchObject({ status: 409 })

    // After the lease lapses, the next isolate takes over and runs it.
    clock.now += 60_001
    const third = await isolate(store)
    const recovered = vi.fn(async () => ({ ok: true }))
    await expect(third.cachedIdempotency(key, recovered, "fp")).resolves.toEqual({ ok: true })
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  test("the same key with a different payload conflicts across isolates", async () => {
    const store = fakeConvexStore()
    const first = await isolate(store)
    const second = await isolate(store)
    const key = registerKey(first, "request_5")

    await first.cachedIdempotency(key, async () => ({ ok: true }), "fingerprint-a")
    // Returning the first payload's result for a different payload would be a
    // silent wrong answer, which is worse than either re-running or refusing.
    await expect(second.cachedIdempotency(key, async () => ({ ok: true }), "fingerprint-b"))
      .rejects.toMatchObject({ status: 409, code: "control_plane_idempotency_payload_mismatch" })
  })

  test("a failed operation releases its claim so a retry can execute", async () => {
    const store = fakeConvexStore()
    const first = await isolate(store)
    const key = registerKey(first, "request_6")

    await expect(
      first.cachedIdempotency(key, async () => {
        throw new Error("runtime unreachable")
      }, "fp"),
    ).rejects.toThrow("runtime unreachable")
    // A failure is not a result: caching it would replay one transient error for
    // the whole TTL.
    expect(store.rows.has(key!)).toBe(false)

    const second = await isolate(store)
    const retry = vi.fn(async () => ({ ok: true }))
    await expect(second.cachedIdempotency(key, retry, "fp")).resolves.toEqual({ ok: true })
    expect(retry).toHaveBeenCalledTimes(1)
  })

  test("a store outage fails the request instead of executing unguarded", async () => {
    // Degrading to "run it anyway" would restore the duplicate-execution bug
    // exactly when Convex is unhealthy — which is when client retries, and so
    // duplicate deliveries, are most likely.
    const first = await isolate({
      begin: async () => {
        throw Object.assign(new Error("Workspace authority request timed out"), { status: 503 })
      },
      complete: async () => {},
      release: async () => {},
    })
    const run = vi.fn(async () => ({ ok: true }))
    await expect(first.cachedIdempotency(registerKey(first, "request_7"), run, "fp"))
      .rejects.toThrow("Workspace authority request timed out")
    expect(run).not.toHaveBeenCalled()
  })
})
