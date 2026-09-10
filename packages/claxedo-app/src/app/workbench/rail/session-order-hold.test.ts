import { describe, expect, test } from "bun:test"
import { holdSessionOrder, isBusyRow } from "./session-order-hold"

type Row = { id: string; active?: boolean; status?: string[] }
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }))
const ids = (list: readonly Row[]) => list.map((row) => row.id)

describe("holdSessionOrder", () => {
  test("without a held order the data's order is the order", () => {
    expect(ids(holdSessionOrder({ next: rows("b", "a", "c"), held: undefined, frozen: true }))).toEqual(["b", "a", "c"])
    expect(ids(holdSessionOrder({ next: rows("b", "a"), held: [], frozen: true }))).toEqual(["b", "a"])
  })

  test("a frozen list does not reorder under the reader", () => {
    // The reader is looking at a, b, c; activity would promote c to the top.
    const next = rows("c", "a", "b")
    expect(ids(holdSessionOrder({ next, held: ["a", "b", "c"], frozen: true }))).toEqual(["a", "b", "c"])
  })

  test("an unfrozen list reorders, which is what makes the rail useful on arrival", () => {
    const next = rows("c", "a", "b")
    expect(ids(holdSessionOrder({ next, held: ["a", "b", "c"], frozen: false }))).toEqual(["c", "a", "b"])
  })

  test("a session created while frozen appears without displacing the rows being aimed at", () => {
    const next = rows("new", "a", "b")
    expect(ids(holdSessionOrder({ next, held: ["a", "b"], frozen: true }))).toEqual(["a", "b", "new"])
  })

  test("and takes its real place as soon as the reader looks away", () => {
    const next = rows("new", "a", "b")
    expect(ids(holdSessionOrder({ next, held: ["a", "b"], frozen: false }))).toEqual(["new", "a", "b"])
  })

  test("a session that disappears while frozen leaves without dragging the others", () => {
    const next = rows("a", "c")
    expect(ids(holdSessionOrder({ next, held: ["a", "b", "c"], frozen: true }))).toEqual(["a", "c"])
  })

  test("a busy row keeps its place even when the list is not frozen", () => {
    // `b` is mid-turn: its activity time keeps moving, so unheld it would climb.
    const next: Row[] = [{ id: "b", active: true }, { id: "a" }, { id: "c" }]
    const held = ["a", "b", "c"]
    expect(ids(holdSessionOrder({ next, held, frozen: false, pinned: isBusyRow }))).toEqual(["a", "b", "c"])
  })

  test("a settled row is free to move again once it stops being busy", () => {
    const next: Row[] = [{ id: "b" }, { id: "a" }, { id: "c" }]
    const held = ["a", "b", "c"]
    expect(ids(holdSessionOrder({ next, held, frozen: false, pinned: isBusyRow }))).toEqual(["b", "a", "c"])
  })
})

describe("isBusyRow", () => {
  test("reads the row's own activity, not its timestamp", () => {
    expect(isBusyRow({ active: true })).toBe(true)
    expect(isBusyRow({ status: ["busy"] })).toBe(true)
    expect(isBusyRow({ status: ["idle"] })).toBe(false)
    expect(isBusyRow({})).toBe(false)
  })
})
