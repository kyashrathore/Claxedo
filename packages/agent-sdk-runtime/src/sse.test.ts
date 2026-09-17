import { describe, expect, test } from "bun:test"
import { attachSseFanout, createSseReplayBuffer, encodeSseData, sseHeaders } from "./sse"

type TestEvent = { type: "delta" | "idle" | "tool-output" | "gap"; value: string }

/** A heartbeat clock that schedules nothing and hands back a recognisable handle. */
function fakeHeartbeatClock(onSchedule?: (fn: () => void) => void) {
  let cleared: unknown
  return {
    setInterval: (fn: () => void) => {
      onSchedule?.(fn)
      return "heartbeat-timer"
    },
    clearInterval: (handle: unknown) => { cleared = handle },
    get cleared() { return cleared },
  }
}

test("SSE responses cannot enter the browser HTTP cache", () => {
  expect(sseHeaders()["Cache-Control"]).toBe("no-store")
})

describe("attachSseFanout", () => {
  test("unsubscribes and clears heartbeat on cleanup", () => {
    let subscriber: ((event: string) => void) | undefined
    const clock = fakeHeartbeatClock()
    const written: unknown[] = []

    const cleanup = attachSseFanout({
      subscribe(fn) {
        subscriber = fn
        return () => {
          subscriber = undefined
        }
      },
      write(event) {
        written.push(event)
      },
      heartbeat: { type: "heartbeat" },
      heartbeatMs: 1000,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    })

    subscriber?.("event-1")
    cleanup()
    subscriber?.("event-2")

    expect(written).toEqual(["event-1"])
    expect(clock.cleared).toBe("heartbeat-timer")
    expect(subscriber).toBeUndefined()
  })

  test("bounds pending writes for slow consumers", async () => {
    const clock = fakeHeartbeatClock()
    let subscriber: ((event: string) => void) | undefined
    const written: string[] = []
    const dropped: unknown[] = []
    const resolvers: Array<() => void> = []

    const cleanup = attachSseFanout({
      subscribe(fn) {
        subscriber = fn
        return () => {
          subscriber = undefined
        }
      },
      write(event) {
        written.push(event as string)
        return new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
      },
      heartbeat: { type: "heartbeat" },
      heartbeatMs: 1000,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      maxPending: 2,
      onDrop(event) {
        dropped.push(event)
      },
    })

    subscriber?.("event-1")
    subscriber?.("event-2")
    subscriber?.("event-3")
    subscriber?.("event-4")

    expect(written).toEqual(["event-1"])
    expect(dropped).toEqual(["event-2"])

    resolvers.shift()?.()
    await Promise.resolve()
    expect(written).toEqual(["event-1", "event-3"])

    resolvers.shift()?.()
    await Promise.resolve()
    expect(written).toEqual(["event-1", "event-3", "event-4"])

    resolvers.shift()?.()
    cleanup()
  })

  test("preserves terminal pending events when slow consumers overflow", async () => {
    const clock = fakeHeartbeatClock()
    let subscriber: ((event: TestEvent) => void) | undefined
    const written: TestEvent[] = []
    const dropped: unknown[] = []
    const resolvers: Array<() => void> = []

    const cleanup = attachSseFanout<TestEvent>({
      subscribe(fn) {
        subscriber = fn
        return () => {
          subscriber = undefined
        }
      },
      write(event) {
        written.push(event as TestEvent)
        return new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
      },
      heartbeat: { type: "heartbeat" },
      heartbeatMs: 1000,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      maxPending: 2,
      isTerminal: (event) => event.type === "idle",
      onDrop(event) {
        dropped.push(event)
      },
    })

    subscriber?.({ type: "delta", value: "1" })
    subscriber?.({ type: "delta", value: "2" })
    subscriber?.({ type: "idle", value: "done" })
    subscriber?.({ type: "delta", value: "3" })

    expect(written).toEqual([{ type: "delta", value: "1" }])
    expect(dropped).toEqual([{ type: "delta", value: "2" }])

    resolvers.shift()?.()
    await Promise.resolve()
    expect(written).toEqual([{ type: "delta", value: "1" }, { type: "idle", value: "done" }])

    resolvers.shift()?.()
    await Promise.resolve()
    expect(written).toEqual([{ type: "delta", value: "1" }, { type: "idle", value: "done" }, { type: "delta", value: "3" }])

    resolvers.shift()?.()
    cleanup()
  })

  test("a shed frame raises one gap notice at the head of the queue, and a fresh one after it is written", async () => {
    const clock = fakeHeartbeatClock()
    let subscriber: ((event: TestEvent) => void) | undefined
    const written: TestEvent[] = []
    const resolvers: Array<() => void> = []
    let notices = 0

    const cleanup = attachSseFanout<TestEvent>({
      subscribe(fn) {
        subscriber = fn
        return () => {
          subscriber = undefined
        }
      },
      write(event) {
        written.push(event as TestEvent)
        return new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
      },
      heartbeat: { type: "heartbeat" },
      heartbeatMs: 1000,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      maxPending: 2,
      isTerminal: (event) => event.type === "tool-output",
      replayGap: () => ({ type: "gap", value: String(++notices) }),
    })

    subscriber?.({ type: "delta", value: "1" })
    subscriber?.({ type: "delta", value: "2" })
    subscriber?.({ type: "tool-output", value: "done" })
    // Overflow: "2" is shed (never "done"), and the notice takes the head.
    subscriber?.({ type: "delta", value: "3" })
    // A second overflow while the notice is still queued raises no second one.
    subscriber?.({ type: "delta", value: "4" })

    expect(written).toEqual([{ type: "delta", value: "1" }])
    expect(notices).toBe(1)

    resolvers.shift()?.()
    await Promise.resolve()
    expect(written.at(-1)).toEqual({ type: "gap", value: "1" })

    resolvers.shift()?.()
    await Promise.resolve()
    expect(written.at(-1)).toEqual({ type: "tool-output", value: "done" })

    // The notice is out; the next shed frame is a new hole and gets its own notice.
    subscriber?.({ type: "delta", value: "5" })
    subscriber?.({ type: "delta", value: "6" })
    expect(notices).toBe(2)

    while (resolvers.length) resolvers.shift()?.()
    cleanup()
  })

  test("drops pending heartbeats before real events for slow consumers", async () => {
    let subscriber: ((event: string) => void) | undefined
    let heartbeatTick: (() => void) | undefined
    const clock = fakeHeartbeatClock((fn) => { heartbeatTick = fn })
    const written: unknown[] = []
    const dropped: unknown[] = []
    const resolvers: Array<() => void> = []
    const heartbeat = { type: "heartbeat" } as const

    const cleanup = attachSseFanout({
      subscribe(fn) {
        subscriber = fn
        return () => {
          subscriber = undefined
        }
      },
      write(event) {
        written.push(event)
        return new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
      },
      heartbeat,
      heartbeatMs: 1000,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      maxPending: 2,
      onDrop(event) {
        dropped.push(event)
      },
    })

    subscriber?.("event-1")
    subscriber?.("event-2")
    heartbeatTick?.()
    subscriber?.("event-3")

    expect(written).toEqual(["event-1"])
    expect(dropped).toEqual([heartbeat])

    resolvers.shift()?.()
    await Promise.resolve()
    expect(written).toEqual(["event-1", "event-2"])

    resolvers.shift()?.()
    await Promise.resolve()
    expect(written).toEqual(["event-1", "event-2", "event-3"])

    resolvers.shift()?.()
    cleanup()
  })

  test("subscribes before replay and deduplicates setup-gap live events", async () => {
    const clock = fakeHeartbeatClock()
    const replay = createSseReplayBuffer<TestEvent>()
    replay.push({ type: "delta", value: "old" })
    const written: Array<{ event: TestEvent; id?: string }> = []

    const cleanup = attachSseFanout<TestEvent>({
      subscribe(fn) {
        const live = { type: "delta", value: "live" } as const
        replay.push(live)
        fn(live)
        return () => {}
      },
      write(event, meta) {
        written.push({ event: event as TestEvent, id: meta?.id })
      },
      heartbeat: { type: "heartbeat" },
      heartbeatMs: 1000,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      lastEventId: "0",
      replay,
      replayLive: false,
    })
    await Promise.resolve()

    expect(written).toEqual([
      { event: { type: "delta", value: "old" }, id: "1" },
      { event: { type: "delta", value: "live" }, id: "2" },
    ])
    cleanup()
  })

  test("emits a replay gap payload instead of partial stale replay", async () => {
    const clock = fakeHeartbeatClock()
    const replay = createSseReplayBuffer<TestEvent>({ maxEvents: 1 })
    replay.push({ type: "delta", value: "1" })
    replay.push({ type: "delta", value: "2" })
    replay.push({ type: "delta", value: "3" })
    const written: unknown[] = []

    const cleanup = attachSseFanout<TestEvent>({
      subscribe() {
        return () => {}
      },
      write(event) {
        written.push(event)
      },
      heartbeat: { type: "heartbeat" },
      heartbeatMs: 1000,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      lastEventId: "1",
      replay,
      replayGap: ({ lastEventId, throughId }) => ({
        type: "delta",
        value: `gap:${lastEventId}:${throughId}`,
      }),
    })
    await Promise.resolve()

    expect(written).toEqual([{ type: "delta", value: "gap:1:3" }])
    cleanup()
  })
})

describe("createSseReplayBuffer", () => {
  test("replays events after a Last-Event-ID cursor", () => {
    const replay = createSseReplayBuffer<TestEvent>()
    replay.push({ type: "delta", value: "1" })
    const cursor = replay.lastId()
    replay.push({ type: "delta", value: "2" })
    replay.push({ type: "delta", value: "3" })

    expect(replay.replayAfter(cursor).map((event) => event.payload.value)).toEqual(["2", "3"])
  })

  test("keeps terminal events in a reserve outside the normal replay window", () => {
    const replay = createSseReplayBuffer<TestEvent>({
      maxEvents: 1,
      maxTerminalEvents: 2,
      isTerminal: (event) => event.type === "idle",
    })
    replay.push({ type: "delta", value: "1" })
    replay.push({ type: "idle", value: "done" })
    replay.push({ type: "delta", value: "2" })

    expect(replay.replayAfter(undefined).map((event) => event.payload)).toEqual([
      { type: "idle", value: "done" },
      { type: "delta", value: "2" },
    ])
  })

  test("detects when the requested replay cursor is older than the retained window", () => {
    const replay = createSseReplayBuffer<TestEvent>({ maxEvents: 1 })
    replay.push({ type: "delta", value: "1" })
    replay.push({ type: "delta", value: "2" })
    replay.push({ type: "delta", value: "3" })

    expect(replay.hasGap("1")).toBe(true)
    expect(replay.hasGap("2")).toBe(false)
    expect(replay.hasGap(undefined)).toBe(false)
  })

  test("continues a reconstructed principal sequence after its last issued cursor", () => {
    const replay = createSseReplayBuffer<TestEvent>({ initialSequence: 7 })
    replay.push({ type: "delta", value: "after reconnect" })

    expect(replay.lastId()).toBe("8")
    expect(replay.replayAfter("7").map((event) => ({ id: event.id, payload: event.payload }))).toEqual([
      { id: "8", payload: { type: "delta", value: "after reconnect" } },
    ])
  })

  test("encodes SSE ids before data", () => {
    expect(new TextDecoder().decode(encodeSseData({ ok: true }, "42"))).toBe("id: 42\ndata: {\"ok\":true}\n\n")
  })
})
