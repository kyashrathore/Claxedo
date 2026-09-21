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

  test("the filesystem root contains every absolute path on its drive", () => {
    const root = ["", ""].join(sep)
    expect(inside(root, root)).toBe(true)
    expect(inside(root, ["", "etc"].join(sep))).toBe(true)
    expect(inside(root, ["", "a", "b"].join(sep))).toBe(true)
  })

  test("a candidate that resolves outside the root is NOT inside", () => {
    expect(inside(root, `${root}${sep}..${sep}other`)).toBe(false)
    expect(inside(root, `${root}${sep}child${sep}..${sep}..${sep}other`)).toBe(false)
    expect(inside(root, ["", "elsewhere"].join(sep))).toBe(false)
    // A realpath is still the caller's job: this is a lexical comparison only.
    expect(inside(root, `${root}${sep}child${sep}..${sep}file`)).toBe(true)
  })
})
