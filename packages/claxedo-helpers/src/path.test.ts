import { describe, expect, test } from "bun:test"
import { sep } from "node:path"
import { inside } from "./path"

describe("inside", () => {
  const root = ["", "a", "workspace"].join(sep)

  test("the root itself counts as inside", () => {
    expect(inside(root, root)).toBe(true)
  })

  test("descendants are inside", () => {
    expect(inside(root, `${root}${sep}file.ts`)).toBe(true)
    expect(inside(root, `${root}${sep}deep${sep}file.ts`)).toBe(true)
  })

  test("a sibling sharing the root as a string prefix is NOT inside", () => {
    expect(inside(root, `${root}-old${sep}file.ts`)).toBe(false)
    expect(inside(root, `${root}x`)).toBe(false)
  })

  test("it normalizes nothing: traversal segments are the caller's job to resolve", () => {
    // A purely lexical check says yes here; callers must pass resolved paths.
    expect(inside(root, `${root}${sep}..${sep}other`)).toBe(true)
    expect(inside(root, ["", "elsewhere"].join(sep))).toBe(false)
  })
})
