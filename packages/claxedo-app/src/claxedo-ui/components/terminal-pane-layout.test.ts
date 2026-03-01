import { describe, expect, test } from "bun:test"
import type { Pane } from "../context/claxedo-layout"
import {
  computeLeafRects,
  computeSplitHandles,
  paneInStore,
  paneLeafIds,
} from "./terminal-pane-layout"

const TREE: Pane = {
  t: "split",
  dir: "v",
  size: 0.6,
  a: { t: "leaf", id: "a" },
  b: {
    t: "split",
    dir: "h",
    size: 0.25,
    a: { t: "leaf", id: "b1" },
    b: { t: "leaf", id: "b2" },
  },
}

describe("terminal-pane-layout", () => {
  test("paneLeafIds returns all leaves in tree order", () => {
    expect(paneLeafIds(TREE)).toEqual(["a", "b1", "b2"])
  })

  test("paneInStore validates all leaves are present", () => {
    const has = new Set(["a", "b1", "b2"])
    expect(paneInStore(TREE, (id) => has.has(id))).toBe(true)
    has.delete("b2")
    expect(paneInStore(TREE, (id) => has.has(id))).toBe(false)
    expect(paneInStore(undefined, () => true)).toBe(false)
  })

  test("computeLeafRects maps each leaf to normalized bounds", () => {
    expect(computeLeafRects(TREE)).toEqual([
      { id: "a", top: 0, left: 0, width: 0.6, height: 1 },
      { id: "b1", top: 0, left: 0.6, width: 0.4, height: 0.25 },
      { id: "b2", top: 0.25, left: 0.6, width: 0.4, height: 0.75 },
    ])
  })

  test("computeSplitHandles returns one handle per split with path metadata", () => {
    expect(computeSplitHandles(TREE)).toEqual([
      {
        path: "",
        dir: "v",
        position: 0.6,
        top: 0,
        left: 0.6,
        width: 0,
        height: 1,
      },
      {
        path: "b",
        dir: "h",
        position: 0.25,
        top: 0.25,
        left: 0.6,
        width: 0.4,
        height: 0,
      },
    ])
  })
})
