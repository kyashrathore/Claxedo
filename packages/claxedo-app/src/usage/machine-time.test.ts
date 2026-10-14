/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { machineTimeSince, wholeMinutes } from "./model"

describe("machine time range", () => {
  test("starts at local midnight on the first day of the chosen range, today counted as its last day", () => {
    const now = new Date(2026, 9, 14, 15, 42, 7, 300).getTime()
    const start = (days: 7 | 30 | 90) => {
      const since = new Date(machineTimeSince(days, now))
      return [since.getFullYear(), since.getMonth(), since.getDate(), since.getHours(), since.getMinutes(), since.getSeconds(), since.getMilliseconds()]
    }
    expect(start(7)).toEqual([2026, 9, 8, 0, 0, 0, 0])
    expect(start(30)).toEqual([2026, 8, 15, 0, 0, 0, 0])
    expect(start(90)).toEqual([2026, 6, 17, 0, 0, 0, 0])
  })

  test("counts whole minutes only", () => {
    expect(wholeMinutes(0)).toBe(0)
    expect(wholeMinutes(59_999)).toBe(0)
    expect(wholeMinutes(102 * 60_000 + 59_999)).toBe(102)
  })
})
