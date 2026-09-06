import { describe, expect, test } from "bun:test"
import { asRecord, isRecord, onlyStrings, readArray, readBoolean, readField, readFiniteNumber, readString, readStringArray, recordOrEmpty } from "./record"

describe("isRecord", () => {
  test("accepts plain objects", () => {
    expect(isRecord({ a: 1 })).toBe(true)
  })

  test("rejects null, arrays and primitives", () => {
    expect(isRecord(null)).toBe(false)
    expect(isRecord([1, 2])).toBe(false)
    expect(isRecord("a")).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })
})

describe("asRecord / recordOrEmpty", () => {
  test("asRecord passes records through and drops non-records", () => {
    const value = { a: 1 }
    expect(asRecord(value)).toBe(value)
    expect(asRecord([1])).toBeUndefined()
  })

  test("recordOrEmpty substitutes an empty record", () => {
    expect(recordOrEmpty("nope")).toEqual({})
  })
})

describe("field readers", () => {
  test("read typed fields and reject mismatches", () => {
    const value: unknown = { s: "x", n: 2, bad: Number.NaN, b: true, list: [1], nested: { a: 1 } }
    expect(readField(value, "nested")).toEqual({ a: 1 })
    expect(readString(value, "s")).toBe("x")
    expect(readString(value, "n")).toBeUndefined()
    expect(readFiniteNumber(value, "n")).toBe(2)
    expect(readFiniteNumber(value, "bad")).toBeUndefined()
    expect(readBoolean(value, "b")).toBe(true)
    expect(readArray(value, "list")).toEqual([1])
    expect(readArray(value, "nested")).toBeUndefined()
  })

  test("return undefined for non-record inputs", () => {
    expect(readField(null, "a")).toBeUndefined()
    expect(readString([1], "a")).toBeUndefined()
  })
})

describe("onlyStrings", () => {
  test("keeps only the string entries of an array", () => {
    expect(onlyStrings(["a", 1, null, "b", undefined, {}])).toEqual(["a", "b"])
  })

  test("answers an empty list for anything that is not an array", () => {
    expect(onlyStrings(undefined)).toEqual([])
    expect(onlyStrings("a")).toEqual([])
    expect(onlyStrings({ 0: "a", length: 1 })).toEqual([])
  })
})

describe("readStringArray", () => {
  test("reads and filters the array at a key", () => {
    expect(readStringArray({ tags: ["a", 2, "b"] }, "tags")).toEqual(["a", "b"])
  })

  test("distinguishes an absent list from one holding no strings", () => {
    expect(readStringArray({}, "tags")).toBeUndefined()
    expect(readStringArray({ tags: [1, 2] }, "tags")).toEqual([])
    expect(readStringArray({ tags: "a" }, "tags")).toBeUndefined()
  })
})
