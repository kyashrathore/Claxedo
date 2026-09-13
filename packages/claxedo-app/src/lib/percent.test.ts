import { describe, expect, test } from "bun:test"
import { readPercent } from "./percent"

describe("percent", () => {
  test("a vendor's measured fraction reads as a whole percent", () => {
    expect(readPercent(72.68615984405457)).toBe(73)
    expect(readPercent(70.77833333333334)).toBe(71)
    expect(readPercent(100)).toBe(100)
  })

  test("rounds to the nearest whole percent, in both directions", () => {
    expect(readPercent(0.4)).toBe(0)
    expect(readPercent(0.5)).toBe(1)
    expect(readPercent(99.6)).toBe(100)
  })
})
