import { describe, expect, test } from "bun:test"
import { reconnectDelayMs } from "./backoff"

describe("reconnectDelayMs", () => {
  const window = { baseMs: 250, ceilingMs: 15_000 }

  test("doubles per failed attempt from the base and stops at the ceiling", () => {
    expect(reconnectDelayMs({ attempt: 1, ...window }, () => 1)).toBe(500)
    expect(reconnectDelayMs({ attempt: 2, ...window }, () => 1)).toBe(1_000)
    expect(reconnectDelayMs({ attempt: 6, ...window }, () => 1)).toBe(15_000)
    expect(reconnectDelayMs({ attempt: 40, ...window }, () => 1)).toBe(15_000)
  })

  test("draws from the upper half of the window, so two reconnects after one failure differ but neither waits under half", () => {
    expect(reconnectDelayMs({ attempt: 3, ...window }, () => 0)).toBe(1_000)
    expect(reconnectDelayMs({ attempt: 3, ...window }, () => 0.5)).toBe(1_500)
    expect(reconnectDelayMs({ attempt: 3, ...window }, () => 1)).toBe(2_000)
  })

  test("an attempt count below one waits the first retry's window", () => {
    expect(reconnectDelayMs({ attempt: 0, ...window }, () => 1)).toBe(500)
  })
})
