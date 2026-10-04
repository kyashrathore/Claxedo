import { describe, expect, test } from "bun:test"
import { boundKeyedRecord, own } from "./value"

describe("own", () => {
  test("reads only the record's own entry: a prototype key is absent", () => {
    const record: Record<string, string> = { call_1: "x" }
    expect(own(record, "call_1")).toBe("x")
    for (const key of ["__proto__", "constructor", "toString"]) expect(own(record, key)).toBeUndefined()
  })
})

describe("boundKeyedRecord", () => {
  test("keeps the record when within the bound and drops the oldest keys past it", () => {
    const record = { a: 1, b: 2, c: 3 }
    expect(boundKeyedRecord(record, 3)).toBe(record)
    expect(boundKeyedRecord(record, 2)).toEqual({ b: 2, c: 3 })
  })
})
