import { describe, it, expect } from "vitest"
import { createWakes, type Wake, type WakeDriver, type WakeResult } from "../src/index"
import { SqliteWakeStore } from "../src/sqlite"

const WS = "ws1"

type Notification = { id: string; result: WakeResult }
type Hint = { serialKey: string | null; fireAt: number }

/**
 * A deployment whose only runner is a per-lane push driver — the hosted
 * `WakeLane` Durable Object's shape: it arms on the engine's nudge and drains
 * with `runDue(serialKey)`. The unscoped sweep does not exist here, so every
 * guarantee these tests assert has to hold on the scoped path alone.
 */
function laneDriven(sinkImpl?: (wake: Wake) => void) {
  const clock = { t: 1_000_000 }
  const store = new SqliteWakeStore()
  const notified: Notification[] = []
  const hints: Hint[] = []
  const driver: WakeDriver = { nudge: (hint) => void hints.push(hint) }
  const wakes = createWakes({
    store,
    driver,
    now: () => clock.t,
    authorize: () => true,
    sinks: {
      settle: async (wake, result) => {
        sinkImpl?.(wake)
        notified.push({ id: wake.id, result })
      },
    },
  })

  // The DO alarm body: drain the lane until a pass makes no progress.
  async function runLane(serialKey: string | null) {
    for (let round = 0; round < 50; round++) {
      const result = await wakes.runDue(serialKey)
      if (result.fired === 0) return result
    }
    throw new Error("lane drain did not settle")
  }

  return { clock, store, wakes, notified, hints, runLane }
}

const watchOptions = (serialKey: string | null) => ({
  sessionId: "s1",
  workspaceId: WS,
  kind: "settle",
  ...(serialKey === null ? {} : { serialKey }),
  eventKey: "never",
})

describe("expiry under a lane-scoped driver", () => {
  it("terminalizes its own lane: expired state, one notification, live budget released", async () => {
    const { clock, store, wakes, notified, runLane } = laneDriven()
    const { wakeId } = await wakes.watch({ ...watchOptions("org:a"), intent: { x: 1 }, expiresIn: "1h" })
    expect(await store.countLive(WS)).toBe(1)

    clock.t += 3_600_000
    await runLane("org:a")

    expect((await store.get(wakeId))!.state).toBe("expired")
    expect(notified).toEqual([{ id: wakeId, result: { trigger: "at", intent: { x: 1 }, expired: true } }])
    expect(await store.countLive(WS)).toBe(0)

    await runLane("org:a")
    expect(notified).toHaveLength(1)
  })

  it("sweeps only its own lane, and the null lane only with the null scope", async () => {
    const { clock, store, wakes, notified, runLane } = laneDriven()
    const a = await wakes.watch({ ...watchOptions("org:a"), intent: { lane: "a" }, expiresIn: "1h" })
    const b = await wakes.watch({ ...watchOptions("org:b"), intent: { lane: "b" }, expiresIn: "1h" })
    const none = await wakes.watch({ ...watchOptions(null), intent: { lane: null }, expiresIn: "1h" })
    clock.t += 3_600_000

    await runLane("org:a")
    expect(notified.map((n) => n.id)).toEqual([a.wakeId])
    expect((await store.get(b.wakeId))!.state).toBe("pending")
    expect((await store.get(none.wakeId))!.state).toBe("pending")

    await runLane(null)
    expect(notified.map((n) => n.id)).toEqual([a.wakeId, none.wakeId])
    expect((await store.get(b.wakeId))!.state).toBe("pending")
  })

  it("elects one notifier when a lane driver and the unscoped sweep race the same deadline", async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    // Parking the sink holds the first winner inside the side effect while the
    // other pass reaches its own CAS — the window a duplicate would appear in.
    const parked: Promise<void>[] = []
    const { clock, store, wakes, notified } = laneDriven(() => void parked.push(gate))
    const { wakeId } = await wakes.watch({ ...watchOptions("org:a"), intent: {}, expiresIn: "1h" })
    clock.t += 3_600_000

    const raced = Promise.all([wakes.runDue("org:a"), wakes.runDue()])
    await new Promise((resolve) => setTimeout(resolve, 25))
    releaseGate()
    await Promise.all([raced, ...parked])

    expect(notified).toHaveLength(1)
    expect((await store.get(wakeId))!.state).toBe("expired")
  })

  it("arms the lane at the deadline, and at both boundaries when a wake has a fire time too", async () => {
    const { clock, wakes, hints } = laneDriven()
    const deadline = clock.t + 3_600_000
    await wakes.watch({ ...watchOptions("org:a"), intent: {}, expiresAt: deadline })
    expect(hints).toEqual([{ serialKey: "org:a", fireAt: deadline }])

    const fireAt = clock.t + 500
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:b", at: fireAt, expiresAt: deadline })
    expect(hints.slice(1)).toEqual([
      { serialKey: "org:b", fireAt },
      { serialKey: "org:b", fireAt: deadline },
    ])
  })

  it("expires an overdue wake rather than firing its intent, even when the fire time has also passed", async () => {
    const { clock, store, wakes, notified, runLane } = laneDriven()
    const { wakeId } = await wakes.schedule({
      workspaceId: WS,
      kind: "settle",
      serialKey: "org:a",
      at: clock.t + 500,
      expiresAt: clock.t + 1_000,
      intent: { n: 1 },
    })
    clock.t += 1_000

    await runLane("org:a")

    expect((await store.get(wakeId))!.state).toBe("expired")
    expect(notified).toEqual([{ id: wakeId, result: { trigger: "at", intent: { n: 1 }, expired: true } }])
  })

  it("a deadline gates admission, not retry: a crashed fire re-drives its answer past the deadline", async () => {
    let boom = true
    const { clock, store, wakes, notified, runLane } = laneDriven(() => {
      if (boom) {
        boom = false
        throw new Error("crash mid-fire")
      }
    })
    const { token, wakeId } = await wakes.requestApproval({
      sessionId: "s1",
      workspaceId: WS,
      kind: "settle",
      serialKey: "org:a",
      prompt: "Approve?",
      expiresIn: "1h",
    })
    await expect(wakes.resolve(token, "yes", { userId: "owner" })).rejects.toThrow("crash mid-fire")
    expect((await store.get(wakeId))!.state).toBe("firing")

    // Past both the lease and the deadline the answer was accepted under.
    clock.t += 3_600_000
    await runLane("org:a")

    expect(notified).toEqual([
      { id: wakeId, result: { trigger: "on_approval", answer: "yes", resolvedBy: { userId: "owner" } } },
    ])
    expect((await store.get(wakeId))!.state).toBe("fired")
  })
})
