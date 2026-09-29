import { describe, expect, test } from "bun:test"
import { boundKeyedRecord } from "./bounded"

describe("boundKeyedRecord", () => {
  test("keeps the record when within the bound and drops the oldest keys past it", () => {
    const record = { a: 1, b: 2, c: 3 }
    expect(boundKeyedRecord(record, 3)).toBe(record)
    expect(boundKeyedRecord(record, 2)).toEqual({ b: 2, c: 3 })
  })
})
