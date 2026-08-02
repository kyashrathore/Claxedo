import { describe, expect, test } from "bun:test"
import { startSyntheticProbe } from "./synthetic"

/**
 * Manual time-driver: replaces `setInterval`/`clearInterval` with hand-cranked
 * tick functions so tests stay deterministic and fast. Mirrors T18's pattern
 * in directory.test.ts where intervals are exercised by direct invocation.
 */
function makeTimer() {
  type Entry = { fn: () => void; ms: number; id: number }
  const entries = new Map<number, Entry>()
  let nextId = 1
  const setIntervalFn = ((fn: () => void, ms: number) => {
    const id = nextId++
    entries.set(id, { fn, ms, id })
    return id as unknown as ReturnType<typeof setInterval>
  }) as unknown as typeof setInterval
  const clearIntervalFn = ((handle: unknown) => {
    if (typeof handle === "number") entries.delete(handle)
  }) as unknown as typeof clearInterval
  return {
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    /** Fire every interval whose period is <= ms (synchronously, in id order). */
    tickByPeriod(ms: number) {
      for (const entry of [...entries.values()].sort((a, b) => a.id - b.id)) {
        if (entry.ms <= ms) entry.fn()
      }
    },
    /** Fire a specific interval id. */
    fireId(id: number) {
      entries.get(id)?.fn()
    },
    list() {
      return [...entries.values()]
    },
    size() {
      return entries.size
    },
  }
}

function makeFakeNow(start = 1_000_000) {
  let value = start
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms
    },
  }
}

describe("startSyntheticProbe", () => {
  test("records a successful probe and updates RTT when relay responds 200", async () => {
    const timer = makeTimer()
    const clock = makeFakeNow()
    let fetchCalls = 0
    let lastUrl = ""
    const fetchImpl = (async (url: string | URL) => {
      fetchCalls++
      lastUrl = String(url)
      // Each fetch advances the clock by 25ms, simulating RTT.
      clock.advance(25)
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch

    const probe = startSyntheticProbe({
      relayUrl: "http://127.0.0.1:7777",
      intervalMs: 1_000,
      summaryIntervalMs: 60_000,
      fetch: fetchImpl,
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    })

    // Fire the probe interval once.
    timer.tickByPeriod(1_000)
    // Allow the async tick body to settle.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(fetchCalls).toBe(1)
    expect(lastUrl).toContain("/health")
    const stats = probe.stats()
    expect(stats.successCount).toBe(1)
    expect(stats.failureCount).toBe(0)
    expect(stats.consecutiveFailures).toBe(0)
    expect(stats.lastRttMs).toBe(25)

    probe.stop()
  })

  test("logs loudly after 3 consecutive failures", async () => {
    const timer = makeTimer()
    const clock = makeFakeNow()
    const errorLogs: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const fetchImpl = (async () => {
      clock.advance(10)
      return new Response("boom", { status: 500 })
    }) as unknown as typeof fetch

    const probe = startSyntheticProbe({
      relayUrl: "http://127.0.0.1:7777",
      intervalMs: 1_000,
      fetch: fetchImpl,
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      logError: (msg, fields) => errorLogs.push({ msg, fields }),
    })

    // First failure — no loud log yet.
    timer.tickByPeriod(1_000)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(errorLogs.length).toBe(0)

    // Second failure — still no loud log.
    timer.tickByPeriod(1_000)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(errorLogs.length).toBe(0)

    // Third consecutive failure — must log loudly.
    timer.tickByPeriod(1_000)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(errorLogs.length).toBeGreaterThanOrEqual(1)
    expect(errorLogs[0].msg).toContain("synthetic probe")
    expect(probe.stats().consecutiveFailures).toBe(3)

    probe.stop()
  })

  test("consecutive failure counter resets on a success", async () => {
    const timer = makeTimer()
    const clock = makeFakeNow()
    let nextStatus = 500
    const fetchImpl = (async () => {
      clock.advance(5)
      return new Response("body", { status: nextStatus })
    }) as unknown as typeof fetch

    const probe = startSyntheticProbe({
      relayUrl: "http://127.0.0.1:7777",
      intervalMs: 1_000,
      fetch: fetchImpl,
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    })

    // Two failures.
    timer.tickByPeriod(1_000)
    await new Promise((r) => setTimeout(r, 0))
    timer.tickByPeriod(1_000)
    await new Promise((r) => setTimeout(r, 0))
    expect(probe.stats().consecutiveFailures).toBe(2)

    // Then a success — counter must reset to 0.
    nextStatus = 200
    timer.tickByPeriod(1_000)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(probe.stats().consecutiveFailures).toBe(0)
    expect(probe.stats().successCount).toBe(1)
    expect(probe.stats().failureCount).toBe(2)

    probe.stop()
  })

  test("computes p50 and p99 when summary interval fires", async () => {
    const timer = makeTimer()
    const clock = makeFakeNow()

    // We'll cycle a list of RTTs across successive probes.
    const rtts = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    let i = 0
    const fetchImpl = (async () => {
      const ms = rtts[i % rtts.length]
      i++
      clock.advance(ms)
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch

    const summaryLogs: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const probe = startSyntheticProbe({
      relayUrl: "http://127.0.0.1:7777",
      intervalMs: 1_000,
      summaryIntervalMs: 5_000,
      fetch: fetchImpl,
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
      logSummary: (msg, fields) => summaryLogs.push({ msg, fields }),
    })

    // Fire probe interval 10 times to accumulate RTTs.
    for (let t = 0; t < 10; t++) {
      timer.tickByPeriod(1_000)
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(probe.stats().successCount).toBe(10)

    // Now fire the summary interval (5_000ms). Both setIntervals were registered;
    // the summary one has period 5_000 so tickByPeriod(5_000) fires both. We
    // care about the summary log being emitted with p50 and p99.
    const before = summaryLogs.length
    timer.tickByPeriod(5_000)
    await new Promise((r) => setTimeout(r, 0))
    expect(summaryLogs.length).toBeGreaterThan(before)
    const last = summaryLogs[summaryLogs.length - 1]
    expect(last.fields).toBeDefined()
    expect(typeof last.fields?.p50).toBe("number")
    expect(typeof last.fields?.p99).toBe("number")
    // Sanity: p50 should be roughly the median of [10..100] ~ 50-60, p99 ~ 100.
    expect(last.fields?.p50 as number).toBeGreaterThan(0)
    expect(last.fields?.p99 as number).toBeGreaterThanOrEqual(last.fields?.p50 as number)

    probe.stop()
  })

  test("stop() clears registered intervals", async () => {
    const timer = makeTimer()
    const clock = makeFakeNow()
    const fetchImpl = (async () => {
      clock.advance(1)
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch

    const probe = startSyntheticProbe({
      relayUrl: "http://127.0.0.1:7777",
      intervalMs: 1_000,
      summaryIntervalMs: 60_000,
      fetch: fetchImpl,
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    })

    // Two intervals registered: probe + summary.
    expect(timer.size()).toBe(2)
    probe.stop()
    expect(timer.size()).toBe(0)
  })

  test("network exception counts as failure (not a crash)", async () => {
    const timer = makeTimer()
    const clock = makeFakeNow()
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch

    const probe = startSyntheticProbe({
      relayUrl: "http://127.0.0.1:7777",
      intervalMs: 1_000,
      fetch: fetchImpl,
      now: clock.now,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    })

    timer.tickByPeriod(1_000)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(probe.stats().failureCount).toBe(1)
    expect(probe.stats().consecutiveFailures).toBe(1)

    probe.stop()
  })
})
