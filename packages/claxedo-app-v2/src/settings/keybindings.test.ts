/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { firstRows, type KeybindingRow } from "./keybindings"

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
