import { describe, expect, test } from "bun:test"
import { harness } from "./state-harness"

describe("J. selectors", () => {
  test("aliveContents returns insertion order", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    expect(h.api.selectors.aliveContents()).toEqual(["a", "b", "c"])
  })

  test("recentContents returns most-recent first", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    expect(h.api.selectors.recentContents()).toEqual(["a", "b"])
  })

  test("contentPane returns the pane id for an active content", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const p1 = h.state().panes[0].id
    expect(h.api.selectors.contentPane("a")).toBe(p1)
  })

  test("contentPane returns null for stashed/orphaned content", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.navigation.show("b")
    expect(h.api.selectors.contentPane("a")).toBeNull()
  })

  test("visiblePanes returns panes in render order", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    const ids = h.api.selectors.visiblePanes().map((p) => p.id)
    expect(ids).toHaveLength(2)
  })

  test("paneRect returns fractional rect", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    const r = h.api.selectors.paneRect(h.api.selectors.contentPane("b")!)!
    expect(r.left).toBeCloseTo(0.5)
    expect(r.width).toBeCloseTo(0.5)
  })

  test("focusedContent returns null when focused pane is empty", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    h.api.panes.assign(h.state().panes[0].id, null)
    expect(h.api.selectors.focusedContent()).toBeNull()
  })

  test("snapshotFor returns the saved snapshot or undefined", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.navigation.show("c")
    expect(h.api.selectors.snapshotFor("a")?.panes.length).toBe(2)
    expect(h.api.selectors.snapshotFor("c")).toBeUndefined()
  })
})
