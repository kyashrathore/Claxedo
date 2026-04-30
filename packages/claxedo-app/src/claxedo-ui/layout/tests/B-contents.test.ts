import { describe, expect, test } from "bun:test"
import { harness } from "./state-harness"

describe("B. contents", () => {
  test("add puts contentId in contentIds and bumps recency", () => {
    const h = harness()
    h.api.contents.add("a")
    expect(h.state().contentIds).toEqual(["a"])
    expect(h.state().contentRecency[0]).toBe("a")
  })

  test("add is idempotent (no duplicate, no recency bump)", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("a")
    expect(h.state().contentIds).toEqual(["a", "b"])
    expect(h.state().contentRecency[0]).toBe("b")
  })

  test("remove deletes from contentIds, recency, snapshots, and nulls referencing pane", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.navigation.show("a")
    h.api.contents.remove("a")
    expect(h.state().contentIds).not.toContain("a")
    expect(h.state().contentRecency).not.toContain("a")
    expect(h.state().panes[0]?.contentId).toBeNull()
    expect(h.state().layoutSnapshots["a"]).toBeUndefined()
  })

  test("remove drops other snapshots that reference the removed content", () => {
    const h = harness()
    h.api.contents.add("a")
    h.api.contents.add("b")
    h.api.contents.add("c")
    h.api.navigation.show("a")
    const p1 = h.api.selectors.contentPane("a")!
    h.api.split.split(p1, "right", "b")
    h.api.navigation.show("c")
    h.api.contents.remove("a")
    expect(h.api.selectors.snapshotFor("a")).toBeUndefined()
    expect(h.api.selectors.snapshotFor("b")).toBeUndefined()
  })
})
