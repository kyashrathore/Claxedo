import { expect, test } from "bun:test"
import { createProcessLoss } from "./process-loss"

test("a lost process reads degraded until it recovers, and each change is reported once", () => {
  let changes = 0
  const loss = createProcessLoss(() => { changes++ })
  expect(loss.health()).toBeUndefined()
  loss.recovered()
  expect(changes).toBe(0)
  loss.record("exited with 9")
  loss.record("exited with 9")
  expect(loss.health()).toEqual({ status: "degraded", reason: "harness_process_lost", message: "exited with 9" })
  expect(changes).toBe(1)
  loss.recovered()
  expect(loss.health()).toBeUndefined()
  expect(changes).toBe(2)
})
