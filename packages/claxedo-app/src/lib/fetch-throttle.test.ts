// Locks in two invariants:
// 1. The global cap is honored even when N >> cap parallel calls arrive.
// 2. Long-lived requests (SSE) never hold a slot, so they cannot starve
//    the queue. Regression guard for the dual-selected-sidebar style
//    pile-up where bootstrap fanned out 30+ workspace requests against a
//    6-slot HTTP/1.1 budget with 2 slots already eaten by event streams.

import { beforeEach, describe, expect, test } from "bun:test"
import {
  __resetFetchThrottleForTests,
  __setFetchThrottleForTests,
  bypassFetchThrottle,
  getFetchThrottle,
  throttledFetch,
} from "./fetch-throttle"

beforeEach(() => {
  __resetFetchThrottleForTests()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("throttledFetch", () => {
  test("caps in-flight regular requests at the configured limit", async () => {
    __setFetchThrottleForTests(4)
    const t = getFetchThrottle()

    const gates = Array.from({ length: 10 }, () => deferred<Response>())
    const peakInFlight = { value: 0 }

    const promises = gates.map((gate, idx) =>
      throttledFetch(async () => {
        peakInFlight.value = Math.max(peakInFlight.value, t.inFlight())
        return gate.promise
      }, { headers: { "x-idx": String(idx) } }),
    )

    // Yield so all callers reach the acquire() point. Only 4 should
    // actually be invoking the underlying fn at this moment; the rest
    // are parked on the waiter queue.
    await new Promise((r) => setTimeout(r, 0))
    expect(t.inFlight()).toBe(4)
    expect(t.queued()).toBe(6)

    // Resolve them one at a time and confirm the cap holds.
    for (let i = 0; i < gates.length; i++) {
      gates[i].resolve(new Response(""))
      await promises[i]
      // After each release, the next waiter should start. Throughout, the
      // running count must never exceed 4.
      expect(t.inFlight()).toBeLessThanOrEqual(4)
    }

    expect(peakInFlight.value).toBe(4)
    expect(t.queued()).toBe(0)
  })

  test("event-stream requests bypass the throttle (long-lived must not starve queue)", async () => {
    __setFetchThrottleForTests(2)
    const t = getFetchThrottle()

    // Fill the cap with two never-resolving regular requests.
    const blockers = [deferred<Response>(), deferred<Response>()]
    void throttledFetch(() => blockers[0].promise, {})
    void throttledFetch(() => blockers[1].promise, {})
    await new Promise((r) => setTimeout(r, 0))
    expect(t.inFlight()).toBe(2)

    // Now fire an SSE request — it must NOT wait for a slot.
    let sseRan = false
    const ssePromise = throttledFetch(
      async () => {
        sseRan = true
        return new Response("")
      },
      { headers: { Accept: "text/event-stream" } },
    )

    await ssePromise
    expect(sseRan).toBe(true)
    // The blockers are still occupying both slots; the SSE didn't touch them.
    expect(t.inFlight()).toBe(2)

    blockers[0].resolve(new Response(""))
    blockers[1].resolve(new Response(""))
  })

  test("explicit bypass marker also skips the throttle", async () => {
    __setFetchThrottleForTests(1)
    const t = getFetchThrottle()

    const blocker = deferred<Response>()
    void throttledFetch(() => blocker.promise, {})
    await new Promise((r) => setTimeout(r, 0))
    expect(t.inFlight()).toBe(1)

    // Long-lived consumer marks itself explicitly via bypassFetchThrottle.
    const bypassed = await throttledFetch(
      async () => new Response("ok"),
      bypassFetchThrottle({ method: "GET" }),
    )
    expect(await bypassed.text()).toBe("ok")
    // Blocker still holding its slot — bypass didn't go through the queue.
    expect(t.inFlight()).toBe(1)

    blocker.resolve(new Response(""))
  })

  test("releases the slot even when the underlying fetch throws", async () => {
    __setFetchThrottleForTests(2)
    const t = getFetchThrottle()

    await expect(
      throttledFetch(async () => {
        throw new Error("network failure")
      }, {}),
    ).rejects.toThrow("network failure")

    // No leaked slot.
    expect(t.inFlight()).toBe(0)
    expect(t.queued()).toBe(0)
  })

  test("queue drains in FIFO order so first caller doesn't starve", async () => {
    __setFetchThrottleForTests(1)

    const gates = Array.from({ length: 5 }, () => deferred<Response>())
    const order: number[] = []

    const promises = gates.map((gate, idx) =>
      throttledFetch(async () => {
        order.push(idx)
        return gate.promise
      }, {}),
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual([0])

    for (let i = 0; i < gates.length; i++) {
      gates[i].resolve(new Response(""))
      await promises[i]
    }
    expect(order).toEqual([0, 1, 2, 3, 4])
  })
})
