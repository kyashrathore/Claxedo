/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { parsePointer } from "./json-pointer"

describe("parsePointer", () => {
  test("reads / and the empty pointer as the whole document", () => {
    expect(parsePointer("/")).toEqual([])
    expect(parsePointer("")).toEqual([])
  })

  test("splits segments and unescapes ~1 and ~0", () => {
    expect(parsePointer("/items/3/title")).toEqual(["items", "3", "title"])
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"])
  })
})
