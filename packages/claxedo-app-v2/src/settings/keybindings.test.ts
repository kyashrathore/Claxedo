/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { firstRows, reuseRows, type KeybindingRow } from "./keybindings"

const row = (id: string, category: string, keybind = ""): KeybindingRow => ({ id, title: id, category, keybind })

describe("firstRows", () => {
  const groups = [
    ["A", [row("a1", "A"), row("a2", "A"), row("a3", "A")]],
    ["B", [row("b1", "B"), row("b2", "B")]],
    ["C", [row("c1", "C")]],
  ] as const

  test("cuts the rows in order at the limit and drops the groups after it", () => {
    const shown = firstRows(groups, 4)
    expect([...shown.keys()]).toEqual(["A", "B"])
    expect(shown.get("A")?.map((item) => item.id)).toEqual(["a1", "a2", "a3"])
    expect(shown.get("B")?.map((item) => item.id)).toEqual(["b1"])
  })

  test("keeps a whole group's array when the limit covers it", () => {
    const shown = firstRows(groups, 10)
    expect(shown.get("A")).toBe(groups[0][1])
    expect([...shown.keys()]).toEqual(["A", "B", "C"])
  })
})

describe("reuseRows", () => {
  test("keeps the previous object for an unchanged row and takes the new one for a changed row", () => {
    const previous = [row("a", "A", "mod+a"), row("b", "A", "mod+b")]
    const next = reuseRows([row("a", "A", "mod+a"), row("b", "A", "mod+shift+b"), row("c", "A")], previous)
    expect(next[0]).toBe(previous[0])
    expect(next[1]).not.toBe(previous[1])
    expect(next[1]?.keybind).toBe("mod+shift+b")
    expect(next[2]?.id).toBe("c")
  })
})
