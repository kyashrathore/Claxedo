import { describe, expect, test } from "bun:test"
import { harness } from "./state-harness"

describe("K. user journeys", () => {
  test("J1–J6: empty → click A → refresh → drop B → navigate C → restore A", () => {
    const h = harness()
    // J1: empty
    expect(h.state().panes).toEqual([])
    // J2: open A
    h.api.contents.add("a")
    h.api.navigation.show("a")
    expect(h.state().panes).toHaveLength(1)
    expect(h.state().panes[0].contentId).toBe("a")
    // J3: simulate refresh — state preserved (we just assert no mutation needed)
    const aPane = h.state().panes[0].id
    expect(h.api.selectors.contentPane("a")).toBe(aPane)
    // J4: drop B side-by-side
    h.api.split.split(aPane, "right", "b")
    expect(h.state().panes).toHaveLength(2)
    // J5: navigate to C
    h.api.contents.add("c")
    h.api.navigation.show("c")
    expect(h.state().panes).toHaveLength(1)
    expect(h.state().panes[0].contentId).toBe("c")
    // J6: navigate back to A → restores A,B side by side
    h.api.navigation.show("a")
    expect(h.state().panes).toHaveLength(2)
    expect(h.api.selectors.contentPane("a")).not.toBeNull()
    expect(h.api.selectors.contentPane("b")).not.toBeNull()
  })

  test("J7–J9: create term-a → create term-b → drag term-a side-by-side", () => {
    const h = harness()
    h.api.contents.add("term-a")
    h.api.navigation.show("term-a")
    h.api.contents.add("term-b")
    h.api.navigation.show("term-b") // single-pane swap
    expect(h.state().panes[0].contentId).toBe("term-b")
    const focused = h.state().focusedPaneId!
    h.api.split.split(focused, "right", "term-a")
    expect(h.state().panes).toHaveLength(2)
    expect(h.api.selectors.contentPane("term-a")).not.toBeNull()
    expect(h.api.selectors.contentPane("term-b")).not.toBeNull()
  })

  test("J10–J12: navigate to D, navigate back to term-a restores", () => {
    const h = harness()
    h.api.contents.add("term-a")
    h.api.contents.add("term-b")
    h.api.navigation.show("term-a")
    h.api.split.split(h.api.selectors.contentPane("term-a")!, "right", "term-b")
    h.api.contents.add("D")
    h.api.navigation.show("D")
    expect(h.state().panes).toHaveLength(1)
    h.api.navigation.show("term-a")
    expect(h.state().panes).toHaveLength(2)
  })

  test("J13–J16: focus pane, close pane, create term-c next to term-a, close term-c", () => {
    const h = harness()
    h.api.contents.add("term-a")
    h.api.contents.add("term-b")
    h.api.navigation.show("term-a")
    h.api.split.split(h.api.selectors.contentPane("term-a")!, "right", "term-b")
    const pa = h.api.selectors.contentPane("term-a")!
    h.api.split.focus(pa)
    expect(h.state().focusedPaneId).toBe(pa)

    // Close term-b's pane
    const pb = h.api.selectors.contentPane("term-b")!
    h.api.split.close(pb, { destroyContent: true })
    expect(h.state().panes).toHaveLength(1)
    expect(h.state().contentIds).not.toContain("term-b")

    // Create term-c next to term-a
    h.api.split.split(pa, "right", "term-c")
    expect(h.state().panes).toHaveLength(2)
    expect(h.api.selectors.contentPane("term-c")).not.toBeNull()

    // Close term-c
    h.api.contents.remove("term-c")
    expect(h.state().contentIds).not.toContain("term-c")
  })
})
