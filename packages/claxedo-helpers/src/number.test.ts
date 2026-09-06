import { describe, expect, test } from "bun:test"
import { parsePositiveInteger, parsePositiveNumber, percentile, round2 } from "./number"

describe("percentile", () => {
  test("nearest rank, no interpolation", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(values, 50)).toBe(5)
    expect(percentile(values, 90)).toBe(9)
    expect(percentile(values, 95)).toBe(10)
    expect(percentile(values, 100)).toBe(10)
    expect(percentile(values, 0)).toBe(1)
  })

  test("sorts a copy, leaving the caller's array untouched", () => {
    const values = [3, 1, 2]
    expect(percentile(values, 50)).toBe(2)
    expect(values).toEqual([3, 1, 2])
  })

  test("sorts numerically, not lexicographically", () => {
    expect(percentile([10, 9, 2], 100)).toBe(10)
  })

  test("empty input and out-of-range ranks are NaN", () => {
    expect(percentile([], 50)).toBeNaN()
    expect(percentile([1], 101)).toBeNaN()
    expect(percentile([1], -1)).toBeNaN()
    expect(percentile([1], Number.NaN)).toBeNaN()
  })
})

describe("round2", () => {
  test("rounds to two decimals", () => {
    expect(round2(1.234)).toBe(1.23)
    expect(round2(1.236)).toBe(1.24)
    expect(round2(2.345)).toBe(2.35)
    expect(round2(0.1 + 0.2)).toBe(0.3)
  })

  test("the scale-and-round float artifact is inherited, not fixed", () => {
    // 1.005 * 100 is 100.49999999999999, so this rounds DOWN. Every copy this
    // replaces had the same artifact; changing it would move existing numbers.
    expect(round2(1.005)).toBe(1)
  })

  test("an already-short value is returned unchanged", () => {
    expect(round2(3)).toBe(3)
    expect(round2(0)).toBe(0)
  })

  test("non-finite input passes through", () => {
    expect(round2(Number.NaN)).toBeNaN()
    expect(round2(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })

  test("a finite value whose scaling overflows is returned unchanged", () => {
    expect(round2(Number.MAX_VALUE)).toBe(Number.MAX_VALUE)
  })
})

describe("parsePositiveNumber", () => {
  test("returns the parsed NUMBER, never the source string", () => {
    expect(parsePositiveNumber(" 42 ")).toBe(42)
    expect(parsePositiveNumber("1.5")).toBe(1.5)
    expect(parsePositiveNumber("1e3")).toBe(1000)
  })

  test("lenient: everything invalid is undefined, nothing throws", () => {
    for (const value of ["0", "-1", "abc", "", "   ", "Infinity", 42, undefined, null]) {
      expect(parsePositiveNumber(value)).toBeUndefined()
    }
  })
})

describe("parsePositiveInteger", () => {
  test("the integral form additionally rejects fractions and unsafe magnitudes", () => {
    expect(parsePositiveInteger(" 42 ")).toBe(42)
    expect(parsePositiveInteger("1e3")).toBe(1000)
    for (const value of ["0", "-1", "1.5", "abc", "", "   ", "9007199254740993", 42, undefined]) {
      expect(parsePositiveInteger(value)).toBeUndefined()
    }
  })
})
