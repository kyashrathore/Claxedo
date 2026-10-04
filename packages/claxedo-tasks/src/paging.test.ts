import { describe, expect, test } from "bun:test"
import { TASKS_BOUNDS } from "./contracts"
import { clampLimit, decodePageCursor, encodePageCursor, paginate } from "./paging"

const rows = [
  { id: "task-a", createdAt: 3_000 },
  { id: "task-b", createdAt: 2_000 },
  { id: "task-c", createdAt: 2_000 },
  { id: "task-d", createdAt: 1_000 },
]

describe("paging", () => {
  test("a cursor round-trips and anything else is rejected", () => {
    expect(decodePageCursor(encodePageCursor({ createdAt: 12, id: "task-a" }))).toEqual({ createdAt: 12, id: "task-a" })
    expect(decodePageCursor(encodePageCursor({ createdAt: 12, id: "task:with:colons" }))).toEqual({
      createdAt: 12,
      id: "task:with:colons",
    })
    for (const bad of ["", "task-a", ":task-a", "12:", "abc:task-a", "1.5:task-a"]) {
      expect(decodePageCursor(bad)).toBeUndefined()
    }
  })

  test("a limit outside the bounds falls to the default or the maximum", () => {
    expect(clampLimit(10)).toBe(10)
    expect(clampLimit(0)).toBe(TASKS_BOUNDS.listLimitDefault)
    expect(clampLimit(-1)).toBe(TASKS_BOUNDS.listLimitDefault)
    expect(clampLimit(1_000)).toBe(TASKS_BOUNDS.listLimitMax)
  })

  test("pages are newest first, tie-broken by id, and never repeat a row", () => {
    const first = paginate(rows, { cursor: null, limit: 2 })
    expect(first.items.map((row) => row.id)).toEqual(["task-a", "task-c"])
    const second = paginate(rows, { cursor: first.nextCursor, limit: 2 })
    expect(second.items.map((row) => row.id)).toEqual(["task-b", "task-d"])
    expect(second.nextCursor).toBeNull()
  })

  test("a row inserted after the first page does not shift the second", () => {
    const first = paginate(rows, { cursor: null, limit: 2 })
    const withNewest = [...rows, { id: "task-z", createdAt: 9_000 }]
    const second = paginate(withNewest, { cursor: first.nextCursor, limit: 2 })
    expect(second.items.map((row) => row.id)).toEqual(["task-b", "task-d"])
  })
})
