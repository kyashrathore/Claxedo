import { describe, expect, test } from "bun:test"
import {
  createProcessLifecycle,
  ProcessLifecycleDisposedError,
  terminateOnParentLoss,
  type ProcessLifecycleEvent,
} from "./process-lifecycle"

/**
 * A deterministic child fixture. No real process, no real timers — the point is
 * to pin the lifecycle contract before any adapter is connected to it, so a
 * failure here names the semantics rather than a spawn flake.
 */
function fixture(input: {
  start?: (generation: number) => Promise<string>
  stop?: (handle: string) => Promise<void> | void
  idleGraceMs?: number
  stopTimeoutMs?: number
} = {}) {
  const timers: Array<{ id: number; fn: () => void; ms: number; cleared: boolean }> = []
  let nextTimer = 1
  const events: ProcessLifecycleEvent[] = []
  const started: number[] = []
  const stopped: string[] = []

  const lifecycle = createProcessLifecycle<string>({
    async start({ generation }) {
      started.push(generation)
      return input.start ? await input.start(generation) : `child-${generation}`
    },
    async stop({ handle }) {
      stopped.push(handle)
      await input.stop?.(handle)
    },
    ...(input.idleGraceMs !== undefined ? { idleGraceMs: input.idleGraceMs } : {}),
    ...(input.stopTimeoutMs !== undefined ? { stopTimeoutMs: input.stopTimeoutMs } : {}),
    setTimeout: (fn, ms) => {
      const id = nextTimer++
      timers.push({ id, fn, ms, cleared: false })
      return id
    },
    clearTimeout: (handle) => {
      const timer = timers.find((item) => item.id === handle)
      if (timer) timer.cleared = true
    },
    onEvent: (event) => events.push(event),
  })

  return {
    lifecycle,
    events,
    started,
    stopped,
    /** Fire every live timer, as the event loop eventually would. */
    fireTimers() {
      for (const timer of timers.filter((item) => !item.cleared)) {
        timer.cleared = true
        timer.fn()
      }
    },
    /**
     * Fire a timer that was already cleared.
     *
     * Not hypothetical: a cleared `setTimeout` can still fire if the callback
     * was already queued, and several timer shims in this repo (fake timers,
     * the Electron main bridge) do not cancel a pending callback at all.
     */
    fireCleared(index: number) {
      timers[index]!.fn()
    },
    liveTimers: () => timers.filter((item) => !item.cleared),
  }
}

describe("harness process lifecycle", () => {
  test("starts nothing until an explicit operation asks for it", () => {
    const harness = fixture()
    expect(harness.lifecycle.state()).toBe("absent")
    expect(harness.lifecycle.generation()).toBe(0)
    expect(harness.started).toEqual([])
  })

  test("concurrent first operations share one startup generation", async () => {
    let resolveStart: ((handle: string) => void) | undefined
    const harness = fixture({
      start: () => new Promise<string>((resolve) => { resolveStart = resolve }),
    })

    const first = harness.lifecycle.ensure()
    const second = harness.lifecycle.ensure()
    const third = harness.lifecycle.ensure()
    resolveStart!("child-1")

    expect(await Promise.all([first, second, third])).toEqual(["child-1", "child-1", "child-1"])
    expect(harness.started).toEqual([1])
    expect(harness.lifecycle.state()).toBe("ready")
  })

  test("a failed startup rejects every joiner and still allows a later retry", async () => {
    // The defect this primitive exists to prevent. OpenCode caches its startup
    // promise and never clears it on failure, so one 15s spawn timeout bricks
    // the adapter for the life of the process: every later call re-awaits the
    // same rejected promise.
    let attempt = 0
    const harness = fixture({
      start: async () => {
        attempt += 1
        if (attempt === 1) throw new Error("spawn timed out")
        return `child-${attempt}`
      },
    })

    const first = harness.lifecycle.ensure()
    const joiner = harness.lifecycle.ensure()
    await expect(first).rejects.toThrow("spawn timed out")
    await expect(joiner).rejects.toThrow("spawn timed out")
    expect(harness.lifecycle.state()).toBe("absent")

    expect(await harness.lifecycle.ensure()).toBe("child-2")
    expect(harness.started).toEqual([1, 2])
  })

  test("a warm operation reuses the live child", async () => {
    const harness = fixture()
    expect(await harness.lifecycle.ensure()).toBe("child-1")
    expect(await harness.lifecycle.ensure()).toBe("child-1")
    expect(harness.started).toEqual([1])
  })

  test("an idle generation is torn down after the grace period", async () => {
    const harness = fixture({ idleGraceMs: 30_000 })
    await harness.lifecycle.ensure()

    harness.fireTimers()
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.stopped).toEqual(["child-1"])
    expect(harness.events.map((event) => event.type)).toContain("idle-timeout")
  })

  test("an active lease suspends the idle deadline until it is released", async () => {
    const harness = fixture()
    const { lease } = await harness.lifecycle.acquire()

    expect(harness.lifecycle.activeLeases()).toBe(1)
    expect(harness.liveTimers()).toHaveLength(0)

    harness.fireTimers()
    expect(harness.stopped).toEqual([])

    lease.release()
    expect(harness.lifecycle.activeLeases()).toBe(0)
    expect(harness.liveTimers()).toHaveLength(1)
  })

  test("the countdown starts only after the LAST lease is released", async () => {
    // Requests, response streams, client-owned event streams, and protocol
    // work all lease the same generation. Any one of them still open must keep
    // the child alive.
    const harness = fixture()
    await harness.lifecycle.ensure()
    const request = harness.lifecycle.lease()
    const stream = harness.lifecycle.lease()
    const events = harness.lifecycle.lease()

    request.release()
    stream.release()
    expect(harness.liveTimers()).toHaveLength(0)

    events.release()
    expect(harness.liveTimers()).toHaveLength(1)
  })

  test("releasing a lease twice does not double-count", async () => {
    const harness = fixture()
    await harness.lifecycle.ensure()
    const first = harness.lifecycle.lease()
    const second = harness.lifecycle.lease()

    first.release()
    first.release()

    expect(harness.lifecycle.activeLeases()).toBe(1)
    second.release()
    expect(harness.lifecycle.activeLeases()).toBe(0)
  })

  test("an idle timer armed for an old generation cannot kill a newer one", async () => {
    // A restart between arming and firing is exactly when this bites, and the
    // symptom — a healthy child dying seconds after a restart — reads as a
    // spawn bug rather than a timer bug.
    const harness = fixture()
    await harness.lifecycle.ensure()   // generation 1 arms timer[0]
    await harness.lifecycle.stop("restart")
    await harness.lifecycle.ensure()   // generation 2 arms timer[1]

    // Generation 1's timer fires late, after its generation is long gone.
    harness.fireCleared(0)
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.lifecycle.generation()).toBe(2)
    expect(harness.lifecycle.state()).toBe("ready")
    expect(harness.stopped).toEqual(["child-1"])

    // Generation 2's own timer still works.
    harness.fireTimers()
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.stopped).toEqual(["child-1", "child-2"])
  })

  test("acquire holds its lease across a slow start", async () => {
    // Without leasing before the await, a slow start arms the idle timer the
    // instant it lands and the caller can watch the child die before using it.
    let resolveStart: ((handle: string) => void) | undefined
    const harness = fixture({ start: () => new Promise<string>((resolve) => { resolveStart = resolve }) })

    const acquiring = harness.lifecycle.acquire()
    expect(harness.lifecycle.activeLeases()).toBe(1)
    resolveStart!("child-1")
    const { lease } = await acquiring

    expect(harness.liveTimers()).toHaveLength(0)
    lease.release()
    expect(harness.liveTimers()).toHaveLength(1)
  })

  test("acquire releases its lease when the start fails", async () => {
    const harness = fixture({ start: async () => { throw new Error("no binary") } })

    await expect(harness.lifecycle.acquire()).rejects.toThrow("no binary")
    expect(harness.lifecycle.activeLeases()).toBe(0)
  })

  test("a child that arrives after a stop is handed straight to stop", async () => {
    let resolveStart: ((handle: string) => void) | undefined
    const harness = fixture({ start: () => new Promise<string>((resolve) => { resolveStart = resolve }) })

    const pending = harness.lifecycle.ensure()
    await harness.lifecycle.stop()
    resolveStart!("child-1")

    await expect(pending).rejects.toThrow(ProcessLifecycleDisposedError)
    expect(harness.stopped).toEqual(["child-1"])
  })

  test("a stop that never completes is abandoned at the bound", async () => {
    // Shutdown must not hang on one uncooperative child.
    const harness = fixture({ stopTimeoutMs: 5_000, stop: () => new Promise<void>(() => {}) })
    await harness.lifecycle.ensure()

    const stopping = harness.lifecycle.stop()
    harness.fireTimers()
    await stopping

    expect(harness.lifecycle.state()).toBe("absent")
  })

  test("dispose forbids further starts", async () => {
    const harness = fixture()
    await harness.lifecycle.ensure()
    await harness.lifecycle.dispose()

    expect(harness.stopped).toEqual(["child-1"])
    await expect(harness.lifecycle.ensure()).rejects.toThrow(ProcessLifecycleDisposedError)
  })

  test("parent loss disposes the lifecycle and detaches cleanly", () => {
    const handlers = new Map<string, Array<() => void>>()
    const fakeProcess = {
      on(event: string, handler: () => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
        return fakeProcess as never
      },
      off(event: string, handler: () => void) {
        handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler))
        return fakeProcess as never
      },
    } as unknown as NodeJS.Process

    const disposals: string[] = []
    const detach = terminateOnParentLoss(
      { dispose: async (reason) => { disposals.push(String(reason)) } },
      { process: fakeProcess, signals: ["SIGTERM"] },
    )

    handlers.get("SIGTERM")?.forEach((handler) => handler())
    expect(disposals).toEqual(["parent-loss"])

    detach()
    expect(handlers.get("SIGTERM")).toEqual([])
    expect(handlers.get("beforeExit")).toEqual([])
  })
})
