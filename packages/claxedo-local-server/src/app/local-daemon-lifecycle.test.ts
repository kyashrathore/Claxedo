import { describe, expect, test, vi } from "vitest"
import {
  createLocalDaemonLifecycle,
  localDaemonResidencyPins,
  type LocalDaemonWorkActivity,
} from "./local-daemon-lifecycle"

const empty = (): LocalDaemonWorkActivity => ({
  pty: { running: 0, committed: 0, provisional: 0, managed: 0, subscribers: 0 },
  runtime: { hosts: 0, activeTurns: 0, activeWrites: 0, checkpointing: 0 },
  residencyPins: 0,
  replacementBlockers: 0,
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("local daemon lifecycle", () => {
  test("counts active sessions, terminals, and managed processes as daemon work", () => {
    const cases: Array<[string, LocalDaemonWorkActivity["pty"], LocalDaemonWorkActivity["runtime"]]> = [
      ["agent session", empty().pty, { ...empty().runtime, activeTurns: 1 }],
      ["session write", empty().pty, { ...empty().runtime, activeWrites: 1 }],
      ["session checkpoint", empty().pty, { ...empty().runtime, checkpointing: 1 }],
      ["terminal", { ...empty().pty, running: 1, committed: 1 }, empty().runtime],
      ["managed process", { ...empty().pty, running: 1, managed: 1 }, empty().runtime],
    ]

    for (const [label, pty, runtime] of cases) {
      expect(localDaemonResidencyPins(pty, runtime), label).toBe(1)
    }
  })

  test("an ordinary lease release keeps one 180-second crash and restart handoff window", async () => {
    vi.useFakeTimers()
    try {
      const onIdle = vi.fn()
      const lifecycle = createLocalDaemonLifecycle({ activity: empty, onIdle })
      lifecycle.start()
      const lease = lifecycle.acquire()!

      lifecycle.release(lease.id)
      await vi.advanceTimersByTimeAsync(179_999)
      expect(onIdle).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(onIdle).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("a replacement app lease acquired inside the handoff window cancels idle shutdown", async () => {
    vi.useFakeTimers()
    try {
      const onIdle = vi.fn()
      const lifecycle = createLocalDaemonLifecycle({ activity: empty, onIdle })
      lifecycle.start()
      const lease = lifecycle.acquire()!

      lifecycle.release(lease.id)
      await vi.advanceTimersByTimeAsync(179_999)
      lifecycle.acquire()
      await vi.advanceTimersByTimeAsync(180_001)

      expect(onIdle).not.toHaveBeenCalled()
      lifecycle.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  test("a clean app shutdown stops as soon as leases and active work are gone", async () => {
    vi.useFakeTimers()
    try {
      const onIdle = vi.fn()
      let pins = 1
      const activity = () => ({ ...empty(), residencyPins: pins, replacementBlockers: pins })
      const lifecycle = createLocalDaemonLifecycle({ activity, onIdle })
      lifecycle.start()
      const lease = lifecycle.acquire()!

      lifecycle.requestShutdown(lease.id)
      await vi.advanceTimersByTimeAsync(360_000)
      expect(onIdle).not.toHaveBeenCalled()

      pins = 0
      lifecycle.reconcile()
      await vi.advanceTimersByTimeAsync(1)
      expect(onIdle).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("a pre-start state snapshot cannot consume lifecycle startup", () => {
    vi.useFakeTimers()
    try {
      const lifecycle = createLocalDaemonLifecycle({ activity: empty, onIdle() {} })
      expect(lifecycle.snapshot().state).toBe("created")
      expect(vi.getTimerCount()).toBe(0)

      lifecycle.start()
      expect(lifecycle.snapshot().state).toBe("idle")
      expect(vi.getTimerCount()).toBe(1)
      lifecycle.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  test("lease changes retain exactly one lifecycle timer", () => {
    vi.useFakeTimers()
    try {
      const lifecycle = createLocalDaemonLifecycle({ activity: empty, onIdle() {} })
      lifecycle.start()
      expect(vi.getTimerCount()).toBe(1)

      const lease = lifecycle.acquire()!
      expect(vi.getTimerCount()).toBe(1)
      expect(lifecycle.renew(lease.id)).toBeDefined()
      expect(vi.getTimerCount()).toBe(1)
      expect(lifecycle.release(lease.id)).toBe(true)
      expect(vi.getTimerCount()).toBe(1)

      lifecycle.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test("expires a crashed desktop lease and exits after one idle grace", async () => {
    const onIdle = vi.fn()
    const lifecycle = createLocalDaemonLifecycle({ activity: empty, onIdle, leaseTtlMs: 20, idleGraceMs: 20, pollIntervalMs: 2 })
    lifecycle.start()
    lifecycle.acquire()

    await wait(30)
    expect(onIdle).not.toHaveBeenCalled()
    await wait(20)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  test("renewal keeps the daemon resident and release starts a fresh grace", async () => {
    const onIdle = vi.fn()
    const lifecycle = createLocalDaemonLifecycle({ activity: empty, onIdle, leaseTtlMs: 30, idleGraceMs: 15, pollIntervalMs: 2 })
    lifecycle.start()
    const lease = lifecycle.acquire()!
    await wait(20)
    expect(lifecycle.renew(lease.id)).toBeDefined()
    await wait(20)
    expect(onIdle).not.toHaveBeenCalled()
    expect(lifecycle.release(lease.id)).toBe(true)
    await wait(20)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  test("authoritative work survives every client lease", async () => {
    const onIdle = vi.fn()
    let pins = 1
    const activity = () => ({ ...empty(), residencyPins: pins, replacementBlockers: pins })
    const lifecycle = createLocalDaemonLifecycle({ activity, onIdle, leaseTtlMs: 20, idleGraceMs: 15, pollIntervalMs: 2 })
    lifecycle.start()

    await wait(50)
    expect(onIdle).not.toHaveBeenCalled()
    pins = 0
    lifecycle.reconcile()
    await wait(20)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  test("an expired lease cannot be renewed", async () => {
    const lifecycle = createLocalDaemonLifecycle({ activity: empty, onIdle() {}, leaseTtlMs: 15, idleGraceMs: 100, pollIntervalMs: 2 })
    lifecycle.start()
    const lease = lifecycle.acquire()!
    await wait(20)
    expect(lifecycle.renew(lease.id)).toBeUndefined()
    lifecycle.stop()
  })
})
