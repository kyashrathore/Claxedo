import { describe, expect, test } from "bun:test"
import { BP_MD, collapsePaneRects, isCollapsedWidth } from "./collapse-projection"
import type { WorkbenchState } from "./types"

function stateWith(
  panes: Array<{ id: string; contentId: string | null }>,
  focusedPaneId: string | null,
): WorkbenchState {
  return {
    panes,
    split: { direction: "h", sizes: panes.map(() => 1 / Math.max(1, panes.length)) },
    contentIds: panes.map((p) => p.contentId).filter((c): c is string => !!c),
    contentRecency: [],
    focusedPaneId,
    layoutSnapshots: {},
  }
}

const FULL_BLEED = { top: 0, left: 0, width: 1, height: 1 }

describe("collapse-projection: isCollapsedWidth", () => {
  test("collapses strictly below BP_MD", () => {
    expect(isCollapsedWidth(BP_MD - 1)).toBe(true)
    expect(isCollapsedWidth(390)).toBe(true)
  })

  test("does not collapse at or above BP_MD", () => {
    expect(isCollapsedWidth(BP_MD)).toBe(false)
    expect(isCollapsedWidth(1280)).toBe(false)
  })

  test("width 0 (pre-measure) is NOT collapsed — avoids a false collapse before layout", () => {
    expect(isCollapsedWidth(0)).toBe(false)
  })
})

describe("collapse-projection: collapsePaneRects", () => {
  test("projects the focused pane full-bleed and hides the rest", () => {
    const state = stateWith(
      [
        { id: "p1", contentId: "a" },
        { id: "p2", contentId: "b" },
      ],
      "p2",
    )
    const rects = collapsePaneRects(state)
    expect(rects.size).toBe(1)
    expect(rects.get("p2")).toEqual(FULL_BLEED)
    expect(rects.has("p1")).toBe(false)
  })

  test("falls back to the first pane when focus is null", () => {
    const state = stateWith(
      [
        { id: "p1", contentId: "a" },
        { id: "p2", contentId: "b" },
      ],
      null,
    )
    const rects = collapsePaneRects(state)
    expect(rects.size).toBe(1)
    expect(rects.get("p1")).toEqual(FULL_BLEED)
  })

  test("falls back to the first pane when focus points at a pane that no longer exists", () => {
    const state = stateWith([{ id: "p1", contentId: "a" }], "gone")
    const rects = collapsePaneRects(state)
    expect(rects.get("p1")).toEqual(FULL_BLEED)
    expect(rects.size).toBe(1)
  })

  test("returns an empty map when there are no panes", () => {
    const state = stateWith([], null)
    expect(collapsePaneRects(state).size).toBe(0)
  })

  test("does not mutate the input state (projection purity)", () => {
    const state = stateWith(
      [
        { id: "p1", contentId: "a" },
        { id: "p2", contentId: "b" },
      ],
      "p1",
    )
    const snapshot = JSON.stringify(state)
    collapsePaneRects(state)
    expect(JSON.stringify(state)).toBe(snapshot)
  })
})
