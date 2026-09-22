import { describe, expect, test } from "bun:test"
import { sep } from "node:path"
import { absoluteConfiguredDir, inside } from "./path"

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

describe("absoluteConfiguredDir", () => {
  test("an absolute directory passes through unchanged", () => {
    const dir = ["", "var", "data"].join(sep)
    expect(absoluteConfiguredDir("CLAXEDO_DATA_DIR", dir)).toBe(dir)
  })

  test("the string a bad env restore leaves behind is refused, not joined", () => {
    expect(() => absoluteConfiguredDir("CLAXEDO_DATA_DIR", "undefined")).toThrow(
      'CLAXEDO_DATA_DIR must be an absolute path, received "undefined"',
    )
  })

  test("any other relative directory is refused, because cwd decides where it lands", () => {
    expect(() => absoluteConfiguredDir("CLAXEDO_STATE_DIR", "data")).toThrow("CLAXEDO_STATE_DIR")
    expect(() => absoluteConfiguredDir("CLAXEDO_STATE_DIR", ["..", "data"].join(sep))).toThrow("CLAXEDO_STATE_DIR")
  })
})
