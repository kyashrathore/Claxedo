import { describe, expect, test } from "bun:test"
import {
  buildAllowedFilter,
  dirsToExpand,
  leafName,
  parentPath,
  resolveTreeKeyAction,
  shouldListExpanded,
  shouldListRoot,
  visibleCountForActivePath,
} from "./file-tree-helpers"

describe("shouldListRoot", () => {
  test("lists an unloaded root at level 0", () => {
    expect(shouldListRoot({ level: 0, dir: undefined })).toBe(true)
    expect(shouldListRoot({ level: 0, dir: {} })).toBe(true)
  })

  test("does not list below the root level", () => {
    expect(shouldListRoot({ level: 1, dir: undefined })).toBe(false)
  })

  test("does not re-list a loaded or in-flight root", () => {
    expect(shouldListRoot({ level: 0, dir: { loaded: true } })).toBe(false)
    expect(shouldListRoot({ level: 0, dir: { loading: true } })).toBe(false)
  })
})

describe("shouldListExpanded", () => {
  test("lists an expanded, unloaded nested directory", () => {
    expect(shouldListExpanded({ level: 1, dir: { expanded: true } })).toBe(true)
  })

  test("never lists the root level here (that is shouldListRoot's job)", () => {
    expect(shouldListExpanded({ level: 0, dir: { expanded: true } })).toBe(false)
  })

  test("does not list a collapsed, loaded, or in-flight directory", () => {
    expect(shouldListExpanded({ level: 1, dir: { expanded: false } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loaded: true } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loading: true } })).toBe(false)
  })
})

describe("dirsToExpand", () => {
  test("returns filter dirs that are not yet expanded, at the root only", () => {
    const filter = { dirs: new Set(["a", "a/b", "a/b/c"]) }
    const expanded = (dir: string) => dir === "a"
    expect(dirsToExpand({ level: 0, filter, expanded }).sort()).toEqual(["a/b", "a/b/c"])
  })

  test("returns nothing below the root or without a filter", () => {
    expect(dirsToExpand({ level: 1, filter: { dirs: new Set(["a"]) }, expanded: () => false })).toEqual([])
    expect(dirsToExpand({ level: 0, filter: undefined, expanded: () => false })).toEqual([])
  })
})

describe("buildAllowedFilter", () => {
  test("keeps every allowed path as a file and collects all prefix directories", () => {
    const { files, dirs } = buildAllowedFilter(["src/a/x.ts", "src/b.ts"])
    expect([...files].sort()).toEqual(["src/a/x.ts", "src/b.ts"])
    expect([...dirs].sort()).toEqual(["src", "src/a"])
  })

  test("a top-level file contributes no directories", () => {
    const { files, dirs } = buildAllowedFilter(["root.ts"])
    expect([...files]).toEqual(["root.ts"])
    expect([...dirs]).toEqual([])
  })

  test("an empty allowed list yields empty sets", () => {
    const { files, dirs } = buildAllowedFilter([])
    expect(files.size).toBe(0)
    expect(dirs.size).toBe(0)
  })
})

describe("parentPath / leafName", () => {
  test("split a nested path into parent and leaf", () => {
    expect(parentPath("src/a/x.ts")).toBe("src/a")
    expect(leafName("src/a/x.ts")).toBe("x.ts")
  })

  test("a path with no separator has an empty parent and is its own leaf", () => {
    expect(parentPath("root.ts")).toBe("")
    expect(leafName("root.ts")).toBe("root.ts")
  })
})

describe("visibleCountForActivePath", () => {
  const paths = Array.from({ length: 60 }, (_, index) => `item-${index}`)

  test("materializes the batch containing the active row", () => {
    expect(visibleCountForActivePath({ paths, active: "item-40", batchSize: 24, current: 24 })).toBe(48)
  })

  test("materializes an active file's ancestor directory", () => {
    expect(
      visibleCountForActivePath({ paths: ["a", "src", "z"], active: "src/deep/file.ts", batchSize: 1, current: 1 }),
    ).toBe(2)
  })

  test("keeps the current count when the active path is outside this level", () => {
    expect(visibleCountForActivePath({ paths, active: "missing/file.ts", batchSize: 24, current: 24 })).toBe(24)
  })
})

describe("resolveTreeKeyAction", () => {
  const base = { index: 2, count: 5, expanded: undefined as boolean | undefined }

  test("Down/Up move focus one step and clamp at the ends", () => {
    expect(resolveTreeKeyAction({ ...base, key: "ArrowDown" })).toEqual({ kind: "focus", index: 3 })
    expect(resolveTreeKeyAction({ ...base, key: "ArrowUp" })).toEqual({ kind: "focus", index: 1 })
    expect(resolveTreeKeyAction({ ...base, key: "ArrowDown", index: 4 })).toEqual({ kind: "focus", index: 4 })
    expect(resolveTreeKeyAction({ ...base, key: "ArrowUp", index: 0 })).toEqual({ kind: "focus", index: 0 })
  })

  test("Home/End jump to the first and last treeitems", () => {
    expect(resolveTreeKeyAction({ ...base, key: "Home" })).toEqual({ kind: "focus", index: 0 })
    expect(resolveTreeKeyAction({ ...base, key: "End" })).toEqual({ kind: "focus", index: 4 })
  })

  test("Right expands a collapsed directory, else moves to the next item", () => {
    expect(resolveTreeKeyAction({ ...base, key: "ArrowRight", expanded: false })).toEqual({ kind: "toggle" })
    expect(resolveTreeKeyAction({ ...base, key: "ArrowRight", expanded: true })).toEqual({ kind: "focus", index: 3 })
  })

  test("Right on a file (no expanded state) does nothing", () => {
    expect(resolveTreeKeyAction({ ...base, key: "ArrowRight", expanded: undefined })).toEqual({ kind: "none" })
  })

  test("Left collapses an expanded directory, else moves to the previous item", () => {
    expect(resolveTreeKeyAction({ ...base, key: "ArrowLeft", expanded: true })).toEqual({ kind: "toggle" })
    expect(resolveTreeKeyAction({ ...base, key: "ArrowLeft", expanded: false })).toEqual({ kind: "focus", index: 1 })
    expect(resolveTreeKeyAction({ ...base, key: "ArrowLeft", expanded: undefined })).toEqual({ kind: "focus", index: 1 })
  })

  test("an empty tree and unhandled keys are no-ops", () => {
    expect(resolveTreeKeyAction({ key: "ArrowDown", index: -1, count: 0, expanded: undefined })).toEqual({ kind: "none" })
    expect(resolveTreeKeyAction({ ...base, key: "a" })).toEqual({ kind: "none" })
  })
})
