/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { gridColumns } from "./grid-columns"

describe("gridColumns", () => {
  test("defaults to two columns and keeps a count the catalog allows", () => {
    expect(gridColumns(undefined)).toBe("2")
    expect([1, 2, 3, 4, 5, 6].map(gridColumns)).toEqual(["1", "2", "3", "4", "5", "6"])
  })

  test("clamps a count outside one to six onto the nearest hook value", () => {
    expect(gridColumns(0)).toBe("1")
    expect(gridColumns(-3)).toBe("1")
    expect(gridColumns(9)).toBe("6")
    expect(gridColumns(2.6)).toBe("3")
    expect(gridColumns(Number.NaN)).toBe("2")
  })
})
