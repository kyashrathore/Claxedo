/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { localMonthStart, wholeMinutes } from "./model"

describe("machine time period", () => {
  test("starts at local midnight on the first day of the month the reader is in", () => {
    const start = new Date(localMonthStart(new Date(2026, 9, 11, 15, 42, 7, 300).getTime()))
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual([2026, 9, 1, 0, 0, 0, 0])
  })

  test("on the first instant of a month is that instant", () => {
    const first = new Date(2026, 0, 1, 0, 0, 0, 0).getTime()
    expect(localMonthStart(first)).toBe(first)
  })

  test("counts whole minutes only", () => {
    expect(wholeMinutes(0)).toBe(0)
    expect(wholeMinutes(59_999)).toBe(0)
    expect(wholeMinutes(102 * 60_000 + 59_999)).toBe(102)
  })
})
