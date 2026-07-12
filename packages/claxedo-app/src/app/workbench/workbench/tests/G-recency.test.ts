import { describe, expect, test } from "bun:test"
import { harness } from "./state-harness"

describe("G. recency", () => {
  test("contents.add bumps the new id to recency front", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    expect(h.state().contentRecency).toEqual(["c", "b", "a"])
  })

  test("focus bumps the focused pane's contentId to front", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.split.focus(h.api.selectors.contentPane("a")!)
    expect(h.state().contentRecency[0]).toBe("a")
  })

  test("navigation.show bumps the target", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.navigation.show("b")
    h.api.navigation.show("a")
    expect(h.state().contentRecency[0]).toBe("a")
  })

  test("removed contents are pruned from recency", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.remove("a")
    expect(h.state().contentRecency).not.toContain("a")
  })

  test("recentContents() returns most-recent first", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    h.api.navigation.show("a")
    expect(h.api.selectors.recentContents()).toEqual(["a", "c", "b"])
  })
})
