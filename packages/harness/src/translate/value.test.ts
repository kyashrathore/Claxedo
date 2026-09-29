import { describe, expect, test } from "bun:test"
import { own } from "./value"

describe("own", () => {
  test("reads only the record's own entry: a prototype key is absent", () => {
    const record: Record<string, string> = { call_1: "x" }
    expect(own(record, "call_1")).toBe("x")
    for (const key of ["__proto__", "constructor", "toString"]) expect(own(record, key)).toBeUndefined()
  })
})
