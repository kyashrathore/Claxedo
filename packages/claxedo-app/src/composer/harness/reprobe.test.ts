/// <reference types="bun" />
import { expect, test } from "bun:test"
import { startHarnessReprobeLoop, type ReprobeScheduler } from "./reprobe"

test("a harness that isn't ready yet is asked again on a doubling backoff that stops and shows the harness unavailable", () => {
  const waits: number[] = []
  let pending: (() => void) | undefined
  const schedule: ReprobeScheduler = (handler, ms) => {
    waits.push(ms)
    pending = handler
    return () => {
      pending = undefined
    }
  }
  let reprobes = 0
  let exhausted = 0
  startHarnessReprobeLoop({ onReprobe: () => void (reprobes += 1), onExhausted: () => void (exhausted += 1), schedule })
  for (let step = 0; step < 100 && pending; step += 1) {
    const next = pending
    pending = undefined
    next()
  }
  expect(exhausted).toBe(1)
  expect(reprobes).toBe(5)
  expect(waits).toEqual([1_500, 3_000, 6_000, 12_000, 24_000, 48_000])
})
