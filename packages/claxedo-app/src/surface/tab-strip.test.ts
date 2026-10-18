/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { selectedTabIndex, tabStripEdge } from "./tab-strip"

describe("tabStripEdge", () => {
  test("names the edges that hide tabs", () => {
    expect(tabStripEdge(0, 300, 300)).toBe("none")
    expect(tabStripEdge(0, 300, 520)).toBe("end")
    expect(tabStripEdge(120, 300, 520)).toBe("both")
    expect(tabStripEdge(220, 300, 520)).toBe("start")
  })

  test("ignores a sub-pixel remainder at either edge", () => {
    expect(tabStripEdge(0.5, 300, 300.6)).toBe("none")
  })
})

describe("selectedTabIndex", () => {
  test("keeps a bound index that names a tab and selects the first tab otherwise", () => {
    expect([2, 0, 3, -1, 1.5].map((value) => selectedTabIndex(value, 3))).toEqual([2, 0, 0, 0, 0])
  })
})
