import { describe, expect, test } from "bun:test"
import { createNativeGoalStore, nativeGoalCommand, NATIVE_GOAL_COMMAND } from "./native-goal-store"

const active = {
  sessionId: "session-1",
  objective: "Ship when checks pass",
  status: "active" as const,
  createdAt: 1,
  updatedAt: 1,
}

describe("native Goal store", () => {
  test("builds the one slash command both native harnesses accept", () => {
    expect(NATIVE_GOAL_COMMAND).toBe("/goal")
    expect(nativeGoalCommand("Ship when checks pass")).toBe("/goal Ship when checks pass")
  })

  test("answers read and stop for the session the driver is holding", async () => {
    const store = createNativeGoalStore()

    expect(await store.read("session-1")).toBeNull()
    expect(await store.stop("session-1")).toBeNull()

    store.apply("session-1", active)
    expect(await store.read("session-1")).toEqual(active)
    expect(await store.stop("session-1")).toMatchObject({ status: "paused" })
    expect(await store.read("session-1")).toMatchObject({ status: "paused" })

    store.apply("session-1", null)
    expect(await store.read("session-1")).toBeNull()
    store.apply("session-1", active)
    store.forget("session-1")
    expect(await store.read("session-1")).toBeNull()
  })

  test("settles a running Goal once and never overrides a state the provider reported", () => {
    const store = createNativeGoalStore()

    expect(store.settleUnfinished("session-1", { status: "blocked" })).toBeNull()

    store.apply("session-1", active)
    expect(store.settleUnfinished("session-1", { status: "blocked", reason: "process exited" }))
      .toMatchObject({ status: "blocked", lastReason: "process exited", objective: active.objective })
    // Already settled: a later failure must not restate or re-publish it.
    expect(store.settleUnfinished("session-1", { status: "paused" })).toBeNull()

    // A settlement with no reason of its own keeps the provider's last one.
    store.apply("session-2", { ...active, sessionId: "session-2", lastReason: "one test remains" })
    expect(store.settleUnfinished("session-2", { status: "paused" }))
      .toMatchObject({ status: "paused", lastReason: "one test remains" })
  })
})
