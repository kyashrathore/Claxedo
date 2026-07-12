import { describe, expect, test } from "bun:test"
import { harness } from "./state-harness"

describe("E. navigation.show", () => {
  test("show(X) when X already in focused pane is no-op", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const before = h.state()
    h.api.navigation.show("a")
    expect(h.state()).toEqual(before)
  })

  test("show(X) when X is in another (non-focused) pane focuses that pane only", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.navigation.show("a")
    expect(h.state().focusedPaneId).toBe(h.api.selectors.contentPane("a")!)
    expect(h.state().layoutSnapshots).toEqual({})
  })

  test("show(X) from 1-pane layout reuses the existing pane (no snapshot save)", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    const paneId = h.state().panes[0].id
    h.api.navigation.show("b")
    expect(h.state().panes).toHaveLength(1)
    expect(h.state().panes[0].id).toBe(paneId)
    expect(h.state().focusedPaneId).toBe(paneId)
    expect(h.state().panes[0].contentId).toBe("b")
    expect(h.state().layoutSnapshots).toEqual({})
  })

  test("show(X) from 2-pane layout saves snapshot for both visible contents", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.navigation.show("c")
    expect(h.api.selectors.snapshotFor("a")).toBeDefined()
    expect(h.api.selectors.snapshotFor("b")).toBeDefined()
    expect(h.state().panes).toHaveLength(1)
    expect(h.state().panes[0].contentId).toBe("c")
  })

  test("show(X) restores X's snapshot when valid", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.navigation.show("c")
    h.api.navigation.show("a")
    expect(h.state().panes).toHaveLength(2)
    expect(h.api.selectors.contentPane("a")).not.toBeNull()
    expect(h.api.selectors.contentPane("b")).not.toBeNull()
    expect(h.state().contentIds).toContain("c")
  })

  test("show(X) falls back to single-pane when X has no snapshot", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    h.api.contents.add("b")
    h.api.navigation.show("b")
    expect(h.state().panes).toHaveLength(1)
    expect(h.state().panes[0].contentId).toBe("b")
  })

  test("show(X) for X not in contentIds is a no-op", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const before = h.state()
    h.api.navigation.show("ghost")
    expect(h.state()).toEqual(before)
  })

  test("layout-shape changes (split, resize, move) do NOT invalidate snapshots", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    h.api.contents.add("d")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.navigation.show("c")
    expect(h.api.selectors.snapshotFor("a")).toBeDefined()
    h.api.split.split(h.api.selectors.contentPane("c")!, "right", "d")
    h.api.split.resize([], 0.3)
    h.api.split.move("d", h.api.selectors.contentPane("d")!, "new")
    expect(h.api.selectors.snapshotFor("a")).toBeDefined()
    expect(h.api.selectors.snapshotFor("b")).toBeDefined()
  })
})
