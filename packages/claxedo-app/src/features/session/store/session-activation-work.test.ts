import { describe, expect, test } from "bun:test"
import {
  ACCEPTED_PROMPT_RECONCILIATION_EARLIEST_MS,
  activationRelativeDelay,
  FIRST_FOLD_SECONDARY_HYDRATION_EARLIEST_MS,
  scheduleActivationWork,
  TURN_SETTLEMENT_CATCH_UP_EARLIEST_MS,
} from "./session-activation-work"

describe("activation-owned cold-path work", () => {
  test("secondary hydration, prompt reconciliation, and settlement catch-up all preserve the first 50 ms", () => {
    expect(FIRST_FOLD_SECONDARY_HYDRATION_EARLIEST_MS).toBeGreaterThanOrEqual(100)
    expect(ACCEPTED_PROMPT_RECONCILIATION_EARLIEST_MS).toBeGreaterThanOrEqual(100)
    expect(TURN_SETTLEMENT_CATCH_UP_EARLIEST_MS).toBeGreaterThanOrEqual(100)
    expect(activationRelativeDelay({ activationAt: 1_000, earliestMs: 100, now: 1_050 })).toBe(50)
  })

  test("scheduled activation work performs zero work through 50 ms and eventually runs exactly once", () => {
    let callback: (() => void) | undefined
    let scheduledDelay = -1
    let runs = 0
    scheduleActivationWork({
      activationAt: 1_000,
      earliestMs: 100,
      now: () => 1_000,
      active: () => true,
      run: () => { runs += 1 },
      schedule: (next, delay) => {
        callback = next
        scheduledDelay = delay
        return 1 as never
      },
      cancel: () => {},
    })

    expect(scheduledDelay).toBe(100)
    expect(runs).toBe(0)
    callback?.()
    callback?.()
    expect(runs).toBe(1)
  })

  test("switch cancellation prevents delayed work and a late callback cannot revive it", () => {
    let callback: (() => void) | undefined
    let cancellations = 0
    let runs = 0
    const cancel = scheduleActivationWork({
      activationAt: 1_000,
      earliestMs: 100,
      now: () => 1_000,
      active: () => true,
      run: () => { runs += 1 },
      schedule: (next) => {
        callback = next
        return 1 as never
      },
      cancel: () => { cancellations += 1 },
    })

    cancel()
    callback?.()
    expect({ runs, cancellations }).toEqual({ runs: 0, cancellations: 1 })
  })

  test("a longer network-quiet policy remains authoritative", () => {
    expect(activationRelativeDelay({
      activationAt: 1_000,
      earliestMs: FIRST_FOLD_SECONDARY_HYDRATION_EARLIEST_MS,
      requestedDelay: 900,
      now: 1_000,
    })).toBe(900)
  })
})
