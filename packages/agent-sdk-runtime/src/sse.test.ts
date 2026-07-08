import { describe, expect, test } from "bun:test"
import { attachSseFanout, createSseReplayBuffer, encodeSseData } from "./sse"

type TestEvent = { type: "delta" | "idle"; value: string }

describe("attachSseFanout", () => {
  test("unsubscribes and clears heartbeat on cleanup", () => {
    const prevSetInterval = globalThis.setInterval
    const prevClearInterval = globalThis.clearInterval
    let subscriber: ((event: string) => void) | undefined
    let cleared: unknown
    const written: unknown[] = []

    globalThis.setInterval = (() => "heartbeat-timer") as typeof setInterval
    globalThis.clearInterval = ((id: unknown) => {
      cleared = id
    }) as typeof clearInterval

    try {
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
      })

      subscriber?.("event-1")
      cleanup()
      subscriber?.("event-2")

      expect(written).toEqual(["event-1"])
      expect(cleared).toBe("heartbeat-timer")
      expect(subscriber).toBeUndefined()
    } finally {
      globalThis.setInterval = prevSetInterval
      globalThis.clearInterval = prevClearInterval
    }
  })

  test("bounds pending writes for slow consumers", async () => {
    const prevSetInterval = globalThis.setInterval
    const prevClearInterval = globalThis.clearInterval
    let subscriber: ((event: string) => void) | undefined
    const written: string[] = []
    const dropped: unknown[] = []
    const resolvers: Array<() => void> = []

    globalThis.setInterval = (() => "heartbeat-timer") as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval

    try {
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
    } finally {
      globalThis.setInterval = prevSetInterval
      globalThis.clearInterval = prevClearInterval
    }
  })

  test("preserves terminal pending events when slow consumers overflow", async () => {
    const prevSetInterval = globalThis.setInterval
    const prevClearInterval = globalThis.clearInterval
    let subscriber: ((event: TestEvent) => void) | undefined
    const written: TestEvent[] = []
    const dropped: unknown[] = []
    const resolvers: Array<() => void> = []

    globalThis.setInterval = (() => "heartbeat-timer") as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval

    try {
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
    } finally {
      globalThis.setInterval = prevSetInterval
      globalThis.clearInterval = prevClearInterval
    }
  })

  test("drops pending heartbeats before real events for slow consumers", async () => {
    const prevSetInterval = globalThis.setInterval
    const prevClearInterval = globalThis.clearInterval
    let subscriber: ((event: string) => void) | undefined
    let heartbeatTick: (() => void) | undefined
    const written: unknown[] = []
    const dropped: unknown[] = []
    const resolvers: Array<() => void> = []
    const heartbeat = { type: "heartbeat" } as const

    globalThis.setInterval = ((fn: () => void) => {
      heartbeatTick = fn
      return "heartbeat-timer"
    }) as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval

    try {
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
    } finally {
      globalThis.setInterval = prevSetInterval
      globalThis.clearInterval = prevClearInterval
    }
  })

  test("subscribes before replay and deduplicates setup-gap live events", async () => {
    const prevSetInterval = globalThis.setInterval
    const prevClearInterval = globalThis.clearInterval
    const replay = createSseReplayBuffer<TestEvent>()
    replay.push({ type: "delta", value: "old" })
    const written: Array<{ event: TestEvent; id?: string }> = []

    globalThis.setInterval = (() => "heartbeat-timer") as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval

    try {
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
    } finally {
      globalThis.setInterval = prevSetInterval
      globalThis.clearInterval = prevClearInterval
    }
  })

  test("emits a replay gap payload instead of partial stale replay", async () => {
    const prevSetInterval = globalThis.setInterval
    const prevClearInterval = globalThis.clearInterval
    const replay = createSseReplayBuffer<TestEvent>({ maxEvents: 1 })
    replay.push({ type: "delta", value: "1" })
    replay.push({ type: "delta", value: "2" })
    replay.push({ type: "delta", value: "3" })
    const written: unknown[] = []

    globalThis.setInterval = (() => "heartbeat-timer") as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval

    try {
      const cleanup = attachSseFanout<TestEvent>({
        subscribe() {
          return () => {}
        },
        write(event) {
          written.push(event)
        },
        heartbeat: { type: "heartbeat" },
        heartbeatMs: 1000,
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
    } finally {
      globalThis.setInterval = prevSetInterval
      globalThis.clearInterval = prevClearInterval
    }
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

  test("encodes SSE ids before data", () => {
    expect(new TextDecoder().decode(encodeSseData({ ok: true }, "42"))).toBe("id: 42\ndata: {\"ok\":true}\n\n")
  })
})
