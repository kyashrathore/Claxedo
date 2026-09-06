import { describe, expect, test } from "bun:test"
import { jsonObject, jsonRecord, sameJson } from "./json"

describe("jsonRecord", () => {
  test("only object payloads survive", () => {
    expect(jsonRecord('{"a":1}')).toEqual({ a: 1 })
    expect(jsonRecord("[1]")).toBeUndefined()
    expect(jsonRecord("1")).toBeUndefined()
    expect(jsonRecord("null")).toBeUndefined()
  })

  test("malformed input and non-strings yield undefined rather than throwing", () => {
    expect(jsonRecord("{")).toBeUndefined()
    expect(jsonRecord("")).toBeUndefined()
    expect(jsonRecord(undefined)).toBeUndefined()
    expect(jsonRecord({ a: 1 })).toBeUndefined()
  })
})

describe("jsonObject", () => {
  test("reads a Request body, totalizing every failure to {}", async () => {
    expect(
      await jsonObject(new Request("https://x/", { method: "POST", body: '{"a":1}' })),
    ).toEqual({ a: 1 })
    expect(await jsonObject(new Request("https://x/", { method: "POST", body: "[1]" }))).toEqual({})
    expect(await jsonObject(new Request("https://x/", { method: "POST", body: "{" }))).toEqual({})
    expect(await jsonObject(new Request("https://x/"))).toEqual({})
  })
})

describe("sameJson", () => {
  test("key order and element order are both significant", () => {
    expect(sameJson({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
    expect(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false)
    expect(sameJson([1, 2], [2, 1])).toBe(false)
  })

  test("undefined on either side is false, never a stringify-collapse true", () => {
    expect(sameJson(undefined, undefined)).toBe(false)
    expect(sameJson(undefined, { a: 1 })).toBe(false)
    expect(sameJson({ a: 1 }, undefined)).toBe(false)
    expect(sameJson(null, null)).toBe(true)
  })
})
