import { describe, expect, test } from "bun:test"
import { readArray, readBoolean, readField, readFiniteNumber, readRecord, readString } from "./readers"

describe("readField", () => {
  test("reads a key of an object and nothing else", () => {
    expect(readField({ a: 1 }, "a")).toBe(1)
    expect(readField({ a: 1 }, "b")).toBeUndefined()
    expect(readField(["x"], "0")).toBeUndefined()
    expect(readField(null, "a")).toBeUndefined()
    expect(readField("text", "length")).toBeUndefined()
  })
})

describe("typed readers", () => {
  const source = { text: "", zero: 0, nan: Number.NaN, flag: false, nested: { a: 1 }, list: [1], nothing: null }

  test("readString keeps an empty string and rejects other types", () => {
    expect(readString(source, "text")).toBe("")
    expect(readString(source, "zero")).toBeUndefined()
    expect(readString(source, "nothing")).toBeUndefined()
  })

  test("readFiniteNumber keeps 0 and rejects NaN", () => {
    expect(readFiniteNumber(source, "zero")).toBe(0)
    expect(readFiniteNumber(source, "nan")).toBeUndefined()
    expect(readFiniteNumber({ big: Number.POSITIVE_INFINITY }, "big")).toBeUndefined()
  })

  test("readBoolean keeps false and rejects 0", () => {
    expect(readBoolean(source, "flag")).toBe(false)
    expect(readBoolean(source, "zero")).toBeUndefined()
  })

  test("readRecord and readArray return the field by reference and reject each other's shape", () => {
    expect(readRecord(source, "nested")).toBe(source.nested)
    expect(readRecord(source, "list")).toBeUndefined()
    expect(readArray(source, "list")).toBe(source.list)
    expect(readArray(source, "nested")).toBeUndefined()
  })
})
