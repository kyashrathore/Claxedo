/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { isBinding, itemScope, parsePointer, resolvePath } from "./data-path"

describe("parsePointer", () => {
  test("reads / and the empty pointer as the whole model", () => {
    expect(parsePointer("/")).toEqual([])
    expect(parsePointer("")).toEqual([])
  })

  test("splits segments and unescapes ~1 and ~0", () => {
    expect(parsePointer("/items/3/title")).toEqual(["items", "3", "title"])
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"])
  })
})

describe("resolvePath", () => {
  const scope = itemScope(["regions"], 1)

  test("an absolute path ignores the template scope", () => {
    expect(resolvePath("/name", scope)).toEqual(["name"])
  })

  test("a relative path resolves inside the item's scope", () => {
    expect(resolvePath("label", scope)).toEqual(["regions", "1", "label"])
    expect(resolvePath("owner/name", scope)).toEqual(["regions", "1", "owner", "name"])
  })

  test("a relative path outside any template resolves from the root", () => {
    expect(resolvePath("name", [])).toEqual(["name"])
  })
})

test("only an object with a string path is a binding", () => {
  expect(isBinding({ path: "/a" })).toBe(true)
  expect(isBinding("a")).toBe(false)
  expect(isBinding(["/a"])).toBe(false)
  expect(isBinding({ path: 1 })).toBe(false)
})
