import { expect, test } from "bun:test"
import { ProcessLosses } from "./health"

test("a lost process reads degraded until its session recovers, and each change is reported once", () => {
  let changes = 0
  const losses = new ProcessLosses(() => { changes++ })
  expect(losses.health("session-1")).toBeUndefined()
  losses.recovered("session-1")
  expect(changes).toBe(0)
  losses.record("session-1", "exited with 9")
  losses.record("session-1", "exited with 9")
  expect(losses.health("session-1")).toEqual({ status: "degraded", reason: "harness_process_lost", message: "exited with 9" })
  expect(losses.health("session-2")).toBeUndefined()
  expect(losses.health(undefined)).toEqual({ status: "degraded", reason: "harness_process_lost", message: "exited with 9" })
  expect(changes).toBe(1)
  losses.recovered("session-1")
  expect(losses.health("session-1")).toBeUndefined()
  expect(changes).toBe(2)
})
