/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { rangeFillPercent } from "./range-fill"

describe("rangeFillPercent", () => {
  test("places the value on the track between min and max", () => {
    expect(rangeFillPercent(10, 0, 100)).toBe(10)
    expect(rangeFillPercent(15, 10, 20)).toBe(50)
  })

  test("keeps a value outside the bounds, and an empty range, on the track", () => {
    expect(rangeFillPercent(-5, 0, 100)).toBe(0)
    expect(rangeFillPercent(140, 0, 100)).toBe(100)
    expect(rangeFillPercent(3, 5, 5)).toBe(0)
  })
})
