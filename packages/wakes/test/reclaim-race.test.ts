import { describe, it, expect } from "vitest"
import { createWakes, type Wakes, type WakeResult } from "../src/index"
import { SqliteWakeStore } from "../src/sqlite"

const WS = "ws1"

// Positive control for the reclaim double-fire bug: two drivers polling the SAME
// store both find one lapsed-lease `firing` row and — on the unfixed code, where
// reclaim was a plain SELECT and the sink ran BEFORE the CAS — both run the sink.
// Atomic `reclaimFiring` must hand the row to exactly one driver.
describe("reclaim race", () => {
  it("two concurrent drivers reclaiming one lapsed-lease firing row fire the sink exactly once", async () => {
    const clock = { t: 1_000_000 }
    const store = new SqliteWakeStore()
    const leaseMs = 30_000

    let entries = 0
    let releaseGate!: () => void
    // The sink parks on this gate so BOTH racing drivers reach the side effect
    // before either completes — that is the exact window the bug exploits.
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const sink = async (_wake: unknown, _result: WakeResult) => {
      entries++
      await gate
    }

    const mkDriver = (): Wakes =>
      createWakes({
        store,
        now: () => clock.t,
        leaseMs,
        sinks: { session_turn: sink as never },
      })
    const driverA = mkDriver()
    const driverB = mkDriver()

    // Get one row into `firing` with a live lease, WITHOUT driving it: claimDue
    // moves pending → firing and stamps lease = t + leaseMs.
    await driverA.schedule({ sessionId: "s1", workspaceId: WS, at: clock.t, intent: { n: 1 } })
    const claimed = await store.claimDue(clock.t, leaseMs, 10)
    expect(claimed).toHaveLength(1)
    expect((await store.listFiring())).toHaveLength(1)

    // Lease lapses → the row is now reclaimable.
    clock.t += 60_000

    // Race two reclaim sweeps. On the unfixed code both read the row and both
    // enter the sink (entries === 2) before parking on the gate.
    const raced = Promise.all([driverA.runDue(), driverB.runDue()])
    await new Promise((r) => setTimeout(r, 25))
    releaseGate()
    await raced

    expect(entries).toBe(1)
    expect((await store.get(claimed[0]!.id))!.state).toBe("fired")
  })

  it("recover does not steal a live lease from an active driver", async () => {
    const clock = { t: 1_000_000 }
    const store = new SqliteWakeStore()
    const leaseMs = 30_000
    let entries = 0
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const sink = async () => {
      entries++
      await gate
    }
    const driverA = createWakes({ store, now: () => clock.t, leaseMs, sinks: { session_turn: sink } })
    const driverB = createWakes({ store, now: () => clock.t, leaseMs, sinks: { session_turn: sink } })

    await driverA.schedule({ sessionId: "s1", workspaceId: WS, at: clock.t, intent: {} })
    const active = driverA.runDue()
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(entries).toBe(1)
    const recovery = driverB.recover()
    await new Promise((resolve) => setTimeout(resolve, 25))
    const entriesBeforeRelease = entries
    releaseGate()
    await Promise.all([active, recovery])

    expect(entriesBeforeRelease).toBe(1)
    expect(await recovery).toEqual({ recovered: 0 })
  })
})
