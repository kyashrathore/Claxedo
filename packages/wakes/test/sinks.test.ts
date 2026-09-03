import { describe, it, expect } from "vitest"
import { createWakes, type Wakes, type WakeResult, type Wake } from "../src/index"
import { SqliteWakeStore } from "../src/sqlite"

const WS = "ws1"

function harness(opts?: {
  spawnTurn?: boolean
  sinks?: Record<string, (wake: Wake, result: WakeResult) => void | Promise<void>>
}) {
  const clock = { t: 1_000_000 }
  const store = new SqliteWakeStore()
  const spawned: Array<{ sessionId: string | null; result: WakeResult }> = []
  const wakes: Wakes = createWakes({
    store,
    now: () => clock.t,
    computeNextRun: (_cron, after) => after + 60_000,
    ...(opts?.spawnTurn === false
      ? {}
      : {
          spawnTurn: async (sessionId, result) => {
            spawned.push({ sessionId, result })
          },
        }),
    ...(opts?.sinks ? { sinks: opts.sinks } : {}),
  })
  return { clock, store, spawned, wakes }
}

describe("sink registry", () => {
  it("fires a custom-kind wake through its registered sink with the wake and result", async () => {
    const settled: Array<{ wake: Wake; result: WakeResult }> = []
    const { clock, wakes, spawned } = harness({
      sinks: { custom_settle: (wake, result) => void settled.push({ wake, result }) },
    })
    await wakes.schedule({ workspaceId: WS, kind: "custom_settle", at: clock.t, intent: { tenant: "org:me" } })

    expect((await wakes.runDue()).fired).toBe(1)
    expect(spawned).toHaveLength(0) // custom kind never routes to session_turn
    expect(settled).toHaveLength(1)
    expect(settled[0]!.wake.kind).toBe("custom_settle")
    expect(settled[0]!.wake.workspaceId).toBe(WS)
    expect(settled[0]!.result).toEqual({ trigger: "at", intent: { tenant: "org:me" } })
  })

  it("defaults to session_turn: existing creators keep firing via spawnTurn", async () => {
    const { clock, wakes, spawned, store } = harness()
    const { wakeId } = await wakes.schedule({ sessionId: "s1", workspaceId: WS, at: clock.t, intent: { n: 1 } })
    expect((await store.get(wakeId))!.kind).toBe("session_turn")
    await wakes.runDue()
    expect(spawned).toEqual([{ sessionId: "s1", result: { trigger: "at", intent: { n: 1 } } }])
  })

  it("an unregistered kind fails the fire and the row stays reclaimable — never half-fires", async () => {
    const { clock, wakes, store, spawned } = harness()
    await wakes.schedule({ workspaceId: WS, kind: "no_such_sink", at: clock.t, intent: {} })

    await expect(wakes.runDue()).rejects.toThrow('no sink registered for wake kind "no_such_sink"')
    expect(spawned).toHaveLength(0)
    // claimed (pending → firing) but not fired: lease reclaim re-drives it once the sink exists
    const [stuck] = await store.listFiring()
    expect(stuck!.kind).toBe("no_such_sink")
    expect(stuck!.state).toBe("firing")
  })

  it("a reclaimed row fires through its sink after the sink is registered (crash-recovery parity)", async () => {
    const first = harness()
    await first.wakes.schedule({ workspaceId: WS, kind: "later_sink", at: first.clock.t, intent: { x: 1 } })
    await expect(first.wakes.runDue()).rejects.toThrow(/no sink registered/)

    // "redeploy" with the sink registered, same store
    const settled: WakeResult[] = []
    const wakes2 = createWakes({
      store: first.store,
      now: () => first.clock.t,
      spawnTurn: async () => {},
      sinks: { later_sink: (_wake, result) => void settled.push(result) },
    })
    first.clock.t += 60_000 // lease lapses
    expect((await wakes2.runDue()).fired).toBe(1)
    expect(settled).toEqual([{ trigger: "at", intent: { x: 1 } }])
  })

  it("recurring wakes preserve their kind on the next occurrence", async () => {
    const fired: Wake[] = []
    const { clock, wakes, store } = harness({ sinks: { custom: (wake) => void fired.push(wake) } })
    await wakes.schedule({ workspaceId: WS, kind: "custom", cron: "* * * * *", intent: {} })
    clock.t += 60_000
    await wakes.runDue()
    expect(fired).toHaveLength(1)
    // the enqueued next occurrence kept the kind
    const next = await store.claimDue(clock.t + 60_000, 1, 10)
    expect(next).toHaveLength(1)
    expect(next[0]!.kind).toBe("custom")
  })

  it("expiry notifications route through the wake's sink, not spawnTurn", async () => {
    const gaveUp: WakeResult[] = []
    const { clock, wakes, spawned } = harness({
      sinks: { custom: (_wake, result) => void gaveUp.push(result) },
    })
    await wakes.watch({ workspaceId: WS, kind: "custom", eventKey: "never", intent: { x: 1 }, expiresAt: clock.t + 500 })
    clock.t += 500
    await wakes.runDue()
    expect(spawned).toHaveLength(0)
    expect(gaveUp).toEqual([{ trigger: "at", intent: { x: 1 }, expired: true }])
  })

  it("createWakes without spawnTurn works when sinks are provided, and rejects with neither", () => {
    expect(() =>
      createWakes({ store: new SqliteWakeStore(), sinks: { custom: () => {} } }),
    ).not.toThrow()
    expect(() => createWakes({ store: new SqliteWakeStore() })).toThrow(/spawnTurn or at least one sink/)
  })
})
