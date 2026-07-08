import { describe, expect, test } from "bun:test"
import { harness } from "./state-harness"
import type { SplitNode } from "../types"

function splitRoot(root: SplitNode | undefined) {
  if (!root || root.t !== "split") throw new Error("expected split root")
  return root
}

describe("D. split.split", () => {
  test("split adds a new pane next to the target on the requested edge", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    const p1 = h.api.selectors.contentPane("a")!
    h.api.split.split(p1, "right", "b")
    expect(h.state().panes).toHaveLength(2)
    const tree = h.state().split.root
    expect(tree).toMatchObject({ t: "split", dir: "h" })
  })

  test("split with bottom edge creates a vertical split", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "bottom", "b")
    expect(h.state().split.root).toMatchObject({ t: "split", dir: "v" })
  })

  test("split where source pane has the surface unbinds the source", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    const p1 = h.api.selectors.contentPane("a")!
    h.api.split.split(p1, "right", "b")
    const p2 = h.api.selectors.contentPane("b")!
    h.api.split.split(p1, "right", "b")
    expect(h.state().panes.find((p) => p.id === p2)?.contentId).toBeNull()
    expect(h.api.selectors.contentPane("b")).not.toBe(p2)
  })

  test("split self-drop (same pane same content) is a no-op", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const p1 = h.api.selectors.contentPane("a")!
    const before = h.state()
    h.api.split.split(p1, "right", "a")
    expect(h.state()).toEqual(before)
  })

  test("split with content not in contentIds implicitly adds it", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const p1 = h.api.selectors.contentPane("a")!
    h.api.split.split(p1, "right", "fresh-content")
    expect(h.state().contentIds).toContain("fresh-content")
    expect(h.api.selectors.contentPane("fresh-content")).not.toBeNull()
  })
})

describe("D. split.close", () => {
  test("close({destroyContent:true}) drops pane and removes content from registry", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    const p2 = h.api.selectors.contentPane("b")!
    h.api.split.close(p2, { destroyContent: true })
    expect(h.state().panes).toHaveLength(1)
    expect(h.state().contentIds).not.toContain("b")
  })

  test("close({destroyContent:false}) drops pane but keeps content alive (orphaned)", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    const p2 = h.api.selectors.contentPane("b")!
    h.api.split.close(p2, { destroyContent: false })
    expect(h.state().panes).toHaveLength(1)
    expect(h.state().contentIds).toContain("b")
    expect(h.api.selectors.contentPane("b")).toBeNull()
  })

  test("closing the last pane leaves zero panes", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const p1 = h.api.selectors.contentPane("a")!
    h.api.split.close(p1, { destroyContent: true })
    expect(h.state().panes).toEqual([])
    expect(h.state().focusedPaneId).toBeNull()
  })

  test("closing a pane invalidates snapshots referencing its destroyed content", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.navigation.show("c")
    h.api.navigation.show("a") // restore
    h.api.split.close(h.api.selectors.contentPane("b")!, { destroyContent: true })
    expect(h.api.selectors.snapshotFor("a")).toBeUndefined()
    expect(h.api.selectors.snapshotFor("b")).toBeUndefined()
  })

  test("closing a pane without destroying content prevents stale split restore", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.navigation.show("c")
    h.api.navigation.show("a")
    h.api.split.close(h.api.selectors.contentPane("b")!, { destroyContent: false })

    h.api.navigation.show("c")
    h.api.navigation.show("a")
    expect(h.state().panes).toHaveLength(1)
    expect(h.api.selectors.contentPane("a")).not.toBeNull()
    expect(h.api.selectors.contentPane("b")).toBeNull()

    h.api.navigation.show("b")
    expect(h.state().panes).toHaveLength(1)
    expect(h.api.selectors.contentPane("a")).toBeNull()
    expect(h.api.selectors.contentPane("b")).not.toBeNull()
  })

  test("tree collapses to single leaf after close", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.split.close(h.api.selectors.contentPane("b")!, { destroyContent: true })
    expect(h.state().split.root).toEqual({ t: "leaf", id: h.state().panes[0].id })
    expect(h.state().split.sizes).toEqual([1])
  })

  test("focused pane closed → focus moves to most-recent surviving pane", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.split.close(h.api.selectors.contentPane("b")!, { destroyContent: true })
    expect(h.state().focusedPaneId).toBe(h.api.selectors.contentPane("a")!)
  })
})

describe("D. split.move", () => {
  test("move shifts content; source pane becomes empty", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    const p1 = h.api.selectors.contentPane("a")!
    const p2 = h.api.selectors.contentPane("b")!
    h.api.split.move("a", p1, p2)
    expect(h.state().panes.find((p) => p.id === p1)?.contentId).toBeNull()
    expect(h.state().panes.find((p) => p.id === p2)?.contentId).toBe("a")
  })

  test('move to "new" creates a fresh pane appended to the tree', () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const p1 = h.api.selectors.contentPane("a")!
    h.api.split.move("a", p1, "new")
    expect(h.state().panes).toHaveLength(2)
    const newPane = h.state().panes.find((p) => p.id !== p1)!
    expect(newPane.contentId).toBe("a")
    expect(h.state().panes.find((p) => p.id === p1)?.contentId).toBeNull()
  })
})

describe("D. split.focus", () => {
  test("focus updates focusedPaneId and bumps recency", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    const p1 = h.api.selectors.contentPane("a")!
    h.api.split.focus(p1)
    expect(h.state().focusedPaneId).toBe(p1)
    expect(h.state().contentRecency[0]).toBe("a")
  })

  test("focus on pane with null content does NOT bump recency", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const p1 = h.api.selectors.contentPane("a")!
    h.api.panes.assign(p1, null)
    const recencyBefore = [...h.state().contentRecency]
    h.api.split.focus(p1)
    expect(h.state().contentRecency).toEqual(recencyBefore)
  })

  test("focus on non-existent pane is a no-op", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const before = h.state()
    h.api.split.focus("ghost")
    expect(h.state()).toEqual(before)
  })
})

describe("D. split.resize", () => {
  test("resize updates the split node size at the given path", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.split.resize([], 0.7)
    expect(splitRoot(h.state().split.root).size).toBe(0.7)
  })

  test("resize clamps to 0..1", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.navigation.show("a")
    h.api.split.split(h.api.selectors.contentPane("a")!, "right", "b")
    h.api.split.resize([], 1.5)
    expect(splitRoot(h.state().split.root).size).toBeLessThanOrEqual(1)
    h.api.split.resize([], -0.2)
    expect(splitRoot(h.state().split.root).size).toBeGreaterThanOrEqual(0)
  })

  test("resize for non-existent path is a no-op", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    const before = h.state()
    h.api.split.resize(["a", "b", "a"], 0.5)
    expect(h.state()).toEqual(before)
  })
})
