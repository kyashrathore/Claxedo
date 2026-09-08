import { describe, expect, test } from "bun:test"
import { createGoalAwareAbort, stopSessionInteraction } from "./submit-abort"

describe("goal-aware abort", () => {
  test("routes to the Goal Stop mutation while a Goal is active", async () => {
    let stops = 0
    let aborts = 0
    const abort = createGoalAwareAbort({
      hasActiveGoal: () => true,
      stopGoal: async () => { stops += 1 },
      promptAbort: async () => { aborts += 1 },
      onStopGoalError: () => { throw new Error("must not fire on success") },
    })
    await abort()
    expect(stops).toBe(1)
    expect(aborts).toBe(0)
  })

  test("surfaces a Goal Stop rejection and still interrupts the running turn", async () => {
    const failures: unknown[] = []
    let aborts = 0
    const abort = createGoalAwareAbort({
      hasActiveGoal: () => true,
      stopGoal: () => Promise.reject(new Error("relay unavailable")),
      promptAbort: async () => { aborts += 1 },
      onStopGoalError: (err) => failures.push(err),
    })
    // Call sites void this promise, so it must RESOLVE after reporting.
    await abort()
    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).message).toBe("relay unavailable")
    // Stop must never be a no-op: the Goal is still running, so the local abort
    // has to interrupt the turn.
    expect(aborts).toBe(1)
  })

  test("a stale active-Goal snapshot still aborts the turn when Stop reports not_found", async () => {
    let aborts = 0
    const notFound = Object.assign(new Error("No Goal for this session"), {
      name: "SessionGoalMutationError",
      status: "not_found",
    })
    const abort = createGoalAwareAbort({
      hasActiveGoal: () => true,
      stopGoal: () => Promise.reject(notFound),
      promptAbort: async () => { aborts += 1 },
      onStopGoalError: () => {},
    })
    await abort()
    expect(aborts).toBe(1)
  })

  test("falls back to the prompt abort when no Goal is active", async () => {
    let aborts = 0
    const abort = createGoalAwareAbort({
      hasActiveGoal: () => false,
      stopGoal: async () => { throw new Error("must not stop a Goal") },
      promptAbort: async () => { aborts += 1 },
      onStopGoalError: () => {},
    })
    await abort()
    expect(aborts).toBe(1)
  })
})

test("interaction Stop pauses only its owning active Goal", async () => {
  const calls: string[] = []
  const handlers = { stopGoal: async () => { calls.push("goal") }, abort: async () => { calls.push("abort") } }
  await stopSessionInteraction({ sessionId: "parent", goal: { sessionId: "parent", status: "active" }, ...handlers })
  await stopSessionInteraction({ sessionId: "child", goal: { sessionId: "parent", status: "active" }, ...handlers })
  expect(calls).toEqual(["goal", "abort"])
})

test("interaction Stop surfaces Goal failure after interrupting its turn", async () => {
  let aborted = false
  await expect(stopSessionInteraction({ sessionId: "owner", goal: { sessionId: "owner", status: "active" },
    stopGoal: async () => { throw new Error("Goal unavailable") }, abort: async () => { aborted = true },
  })).rejects.toThrow("Goal unavailable")
  expect(aborted).toBe(true)
})
