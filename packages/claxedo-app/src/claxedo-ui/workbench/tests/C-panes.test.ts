import { describe, expect, test } from "bun:test"
import { harness } from "./state-harness"

describe("C. panes.assign", () => {
  test("assign sets a pane's contentId", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const pid = h.api.selectors.contentPane("a")!
    h.api.contents.add("b")
    h.api.panes.assign(pid, "b")
    expect(h.state().panes[0].contentId).toBe("b")
  })

  test("assign(p, X) where X is in another pane unbinds the other pane", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    const p1 = h.api.selectors.contentPane("a")!
    h.api.split.split(p1, "right", "b")
    const p2 = h.api.selectors.contentPane("b")!
    h.api.panes.assign(p1, "b")
    expect(h.state().panes.find((p) => p.id === p1)?.contentId).toBe("b")
    expect(h.state().panes.find((p) => p.id === p2)?.contentId).toBeNull()
  })

  test("assign(p, null) leaves pane empty", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const pid = h.api.selectors.contentPane("a")!
    h.api.panes.assign(pid, null)
    expect(h.state().panes[0].contentId).toBeNull()
  })

  test("assign with content not in contentIds is a no-op", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const pid = h.api.selectors.contentPane("a")!
    const before = h.state()
    h.api.panes.assign(pid, "ghost")
    expect(h.state()).toEqual(before)
  })
})
