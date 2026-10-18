/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { tabStripEdge } from "./tab-strip"

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
