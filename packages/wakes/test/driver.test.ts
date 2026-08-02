import { describe, it, expect } from "vitest"
import { createWakes, createNodeWakeDriver, type Wake, type WakeDriver } from "../src/index"
import { SqliteWakeStore } from "../src/sqlite"

const WS = "ws1"

function harness(sinkImpl?: (wake: Wake) => void | Promise<void>) {
  const clock = { t: 1_000_000 }
  const store = new SqliteWakeStore()
  const fired: Wake[] = []
  const errors: unknown[] = []
  const driver = createNodeWakeDriver({ now: () => clock.t, onError: (e) => void errors.push(e) })
  const wakes = createWakes({
    store,
    driver,
    now: () => clock.t,
    sinks: {
      settle: async (wake) => {
        await sinkImpl?.(wake)
        fired.push(wake)
      },
    },
  })
  driver.bind(wakes)
  return { clock, store, fired, errors, driver, wakes }
}

describe("push driver", () => {
  it("a due-now wake fires from the schedule() nudge without any runDue tick", async () => {
    const { clock, wakes, fired, driver } = harness()
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t, intent: { n: 1 } })
    await driver.idle()
    expect(fired.map((w) => JSON.parse(w.intentJson))).toEqual([{ n: 1 }])
  })

  it("null-key due-now wakes also fire via the driver", async () => {
    const { clock, wakes, fired, driver } = harness()
    await wakes.schedule({ workspaceId: WS, kind: "settle", at: clock.t, intent: {} })
    await driver.idle()
    expect(fired).toHaveLength(1)
  })

  it("a burst of same-lane nudges coalesces but drains every due wake", async () => {
    const order: number[] = []
    const { clock, wakes, driver } = harness((wake) => void order.push(JSON.parse(wake.intentJson).n))
    // A slow sink is not needed: enqueue 5 wakes back to back; the driver may
    // coalesce interior nudges, yet each run claims one lane wake and later
    // nudges re-arm until the lane drains.
    for (let n = 1; n <= 5; n++) {
      await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t, intent: { n } })
    }
    await driver.idle()
    // Every due wake drains exactly once: never dropped, never fired twice.
    // Same-lane wakes sharing a millisecond drain in ULID id order, which is
    // random within that millisecond, so the sequence itself is not a promise.
    expect([...order].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it("future wakes are not fired early by the driver (the sweep owns them)", async () => {
    const { clock, wakes, fired, driver } = harness()
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t + 60_000, intent: {} })
    await driver.idle()
    expect(fired).toHaveLength(0)
    clock.t += 60_000
    await wakes.runDue() // the polling backstop
    expect(fired).toHaveLength(1)
  })

  it("a crashing sink surfaces on onError and the sweep retries after the lease lapses", async () => {
    let boom = true
    const { clock, wakes, fired, errors, driver } = harness(() => {
      if (boom) {
        boom = false
        throw new Error("crash")
      }
    })
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t, intent: {} })
    await driver.idle()
    expect(fired).toHaveLength(0)
    expect(errors).toHaveLength(1)
    clock.t += 60_000
    expect((await wakes.runDue()).fired).toBe(1)
    expect(fired).toHaveLength(1)
  })

  it("a throwing driver never breaks schedule(); the sweep still delivers", async () => {
    const clock = { t: 1_000_000 }
    const store = new SqliteWakeStore()
    const fired: Wake[] = []
    const badDriver: WakeDriver = {
      nudge: () => {
        throw new Error("driver down")
      },
    }
    const wakes = createWakes({
      store,
      driver: badDriver,
      now: () => clock.t,
      sinks: { settle: (wake) => void fired.push(wake) },
    })
    await expect(
      wakes.schedule({ workspaceId: WS, kind: "settle", at: clock.t, intent: {} }),
    ).resolves.toHaveProperty("wakeId")
    expect((await wakes.runDue()).fired).toBe(1)
    expect(fired).toHaveLength(1)
  })

  it("lane-scoped runDue touches only its lane", async () => {
    const clock = { t: 1_000_000 }
    const store = new SqliteWakeStore()
    const fired: Wake[] = []
    const wakes = createWakes({
      store,
      now: () => clock.t,
      sinks: { settle: (wake) => void fired.push(wake) },
    })
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:a", at: clock.t, intent: {} })
    await wakes.schedule({ workspaceId: WS, kind: "settle", serialKey: "org:b", at: clock.t, intent: {} })
    await wakes.schedule({ workspaceId: WS, kind: "settle", at: clock.t, intent: {} })
    clock.t += 1

    expect((await wakes.runDue("org:a")).fired).toBe(1)
    expect(fired.map((w) => w.serialKey)).toEqual(["org:a"])

    expect((await wakes.runDue(null)).fired).toBe(1) // null lane only
    expect(fired.map((w) => w.serialKey)).toEqual(["org:a", null])

    expect((await wakes.runDue()).fired).toBe(1) // global sweep gets the rest
    expect(fired.map((w) => w.serialKey)).toEqual(["org:a", null, "org:b"])
  })
})
