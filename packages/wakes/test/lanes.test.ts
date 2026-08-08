import { describe, it, expect } from "vitest"
import { createWakes, type Wakes, type Wake } from "../src/index"
import { SqliteWakeStore } from "../src/sqlite"

const WS = "ws1"

function harness(sinkImpl?: (wake: Wake) => void | Promise<void>) {
  const clock = { t: 1_000_000 }
  const store = new SqliteWakeStore()
  const fired: Wake[] = []
  const wakes: Wakes = createWakes({
    store,
    now: () => clock.t,
    sinks: {
      settle: async (wake) => {
        await sinkImpl?.(wake)
        fired.push(wake)
      },
    },
  })
  return { clock, store, fired, wakes }
}

describe("serialization lanes (serialKey)", () => {
  it("claims at most one wake per key per batch: same-key wakes fire strictly one runDue at a time", async () => {
    const { clock, wakes, fired } = harness()
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t, intent: { n: 1 } })
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t + 1, intent: { n: 2 } })
    clock.t += 10

    expect((await wakes.runDue()).fired).toBe(1)
    expect(fired.map((w) => JSON.parse(w.intentJson))).toEqual([{ n: 1 }]) // earliest first

    expect((await wakes.runDue()).fired).toBe(1)
    expect(fired.map((w) => JSON.parse(w.intentJson))).toEqual([{ n: 1 }, { n: 2 }])
  })

  it("different keys are claimed together and fire in the same runDue", async () => {
    const { clock, wakes, fired } = harness()
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t, intent: {} })
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:b", at: clock.t, intent: {} })
    clock.t += 1
    expect((await wakes.runDue()).fired).toBe(2)
    expect(fired.map((w) => w.serialKey).sort()).toEqual(["org:a", "org:b"])
  })

  it("null-key wakes have no lane: all claimable in one batch", async () => {
    const { clock, wakes } = harness()
    await wakes.schedule({ workspaceId: WS, kind: "settle", at: clock.t, intent: {} })
    await wakes.schedule({ workspaceId: WS, kind: "settle", at: clock.t, intent: {} })
    clock.t += 1
    expect((await wakes.runDue()).fired).toBe(2)
  })

  it("a crashed fire holds its lane while the lease is live, then the lapsed lease frees it", async () => {
    let boom = true
    const { clock, wakes, store, fired } = harness(() => {
      if (boom) {
        boom = false
        throw new Error("crash mid-fire")
      }
    })
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t, intent: { n: 1 } })
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t + 1, intent: { n: 2 } })
    clock.t += 10

    // first claim crashes → row stuck in firing, lane held
    await expect(wakes.runDue()).rejects.toThrow("crash mid-fire")
    expect(await store.listFiring()).toHaveLength(1)

    // lease still live: the same-key pending wake must NOT be claimable
    clock.t += 1_000 // < 30s default lease
    expect(await wakes.runDue("org:a")).toEqual({ fired: 0, blockedUntil: 1_030_010 })
    expect(fired).toHaveLength(0)

    // lease lapses: reclaim re-drives the stuck wake, freeing the lane for the second
    clock.t += 60_000
    expect((await wakes.runDue()).fired).toBe(2)
    expect(fired.map((w) => JSON.parse(w.intentJson))).toEqual([{ n: 1 }, { n: 2 }])
  })

  it("a lane blocks only its own key: other keys keep firing while it is held", async () => {
    let boom = true
    const { clock, wakes, fired } = harness((wake) => {
      if (boom && wake.serialKey === "org:a") {
        boom = false
        throw new Error("crash")
      }
    })
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t, intent: {} })
    clock.t += 1
    await expect(wakes.runDue()).rejects.toThrow("crash")

    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t, intent: {} })
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:b", at: clock.t, intent: {} })
    clock.t += 1
    // org:a's lane is held by the stuck row; org:b is unaffected
    expect((await wakes.runDue()).fired).toBe(1)
    expect(fired.map((w) => w.serialKey)).toEqual(["org:b"])
  })

  it("recurring wakes carry their serialKey onto the next occurrence", async () => {
    const clock = { t: 1_000_000 }
    const store = new SqliteWakeStore()
    const wakes = createWakes({
      store,
      now: () => clock.t,
      computeNextRun: (_cron, after) => after + 60_000,
      sinks: { settle: () => {} },
    })
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", cron: "* * * * *", intent: {} })
    clock.t += 60_000
    await wakes.runDue()
    const [next] = await store.claimDue(clock.t + 60_000, 1, 10)
    expect(next!.serialKey).toBe("org:a")
  })
})
