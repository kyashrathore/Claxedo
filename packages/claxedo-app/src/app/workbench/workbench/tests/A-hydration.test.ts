import { describe, expect, test } from "bun:test"
import { validate, constructWorkbenchState } from "../index"

describe("A. hydration", () => {
  test("validate(undefined) returns empty state with dirty=true", () => {
    const { state, dirty } = validate(undefined)
    expect(state.panes).toEqual([])
    expect(state.split.root).toBeUndefined()
    expect(state.contentIds).toEqual([])
    expect(state.focusedPaneId).toBeNull()
    expect(dirty).toBe(true)
  })

  test("validate(unparseable) returns empty state with dirty=true", () => {
    expect(validate({ wrong: "shape" }).dirty).toBe(true)
    expect(validate("string").dirty).toBe(true)
    expect(validate([]).dirty).toBe(true)
  })

  test("validate keeps a clean blob unchanged with dirty=false", () => {
    const clean = constructWorkbenchState.singlePane("a")
    const seeded = { ...clean, contentIds: ["a"], contentRecency: ["a"] }
    const { state, dirty } = validate(seeded)
    expect(state).toEqual(seeded)
    expect(dirty).toBe(false)
  })

  test("validate drops pane.contentId refs not in contentIds", () => {
    const blob = {
      panes: [{ id: "p1", contentId: "ghost" }],
      split: { direction: "h", sizes: [1], root: { t: "leaf", id: "p1" } },
      contentIds: [],
      contentRecency: [],
      focusedPaneId: "p1",
      layoutSnapshots: {},
    }
    const { state, dirty } = validate(blob)
    expect(state.panes[0].contentId).toBeNull()
    expect(dirty).toBe(true)
  })

  test("validate prunes split-tree leaves whose paneId isn't in panes[]", () => {
    const blob = {
      panes: [{ id: "p1", contentId: null }],
      split: {
        direction: "h",
        sizes: [0.5, 0.5],
        root: {
          t: "split",
          dir: "h",
          a: { t: "leaf", id: "p1" },
          b: { t: "leaf", id: "p_ghost" },
          size: 0.5,
        },
      },
      contentIds: [],
      contentRecency: [],
      focusedPaneId: "p1",
      layoutSnapshots: {},
    }
    const { state, dirty } = validate(blob)
    expect(state.split.root).toEqual({ t: "leaf", id: "p1" })
    expect(dirty).toBe(true)
  })

  test("validate drops snapshots referencing removed contentIds", () => {
    const blob = {
      panes: [{ id: "p1", contentId: "a" }],
      split: { direction: "h", sizes: [1], root: { t: "leaf", id: "p1" } },
      contentIds: ["a"],
      contentRecency: ["a"],
      focusedPaneId: "p1",
      layoutSnapshots: {
        a: {
          panes: [{ id: "p1", contentId: "ghost" }],
          split: { direction: "h", sizes: [1], root: { t: "leaf", id: "p1" } },
          focusedPaneId: "p1",
        },
      },
    }
    const { state, dirty } = validate(blob)
    expect(state.layoutSnapshots["a"]).toBeUndefined()
    expect(dirty).toBe(true)
  })

  test("validate fixes focusedPaneId to a real pane", () => {
    const blob = {
      panes: [{ id: "p1", contentId: null }],
      split: { direction: "h", sizes: [1], root: { t: "leaf", id: "p1" } },
      contentIds: [],
      contentRecency: [],
      focusedPaneId: "ghost",
      layoutSnapshots: {},
    }
    const { state, dirty } = validate(blob)
    expect(state.focusedPaneId).toBe("p1")
    expect(dirty).toBe(true)
  })

  test("validate fixes focusedPaneId to null when no panes", () => {
    const blob = {
      panes: [],
      split: { direction: "h", sizes: [], root: undefined },
      contentIds: [],
      contentRecency: [],
      focusedPaneId: "ghost",
      layoutSnapshots: {},
    }
    const { state, dirty } = validate(blob)
    expect(state.focusedPaneId).toBeNull()
    expect(dirty).toBe(true)
  })

  test("validate backfills missing fields (older schema)", () => {
    const blob = { panes: [], split: { direction: "h", sizes: [] } }
    const { state, dirty } = validate(blob)
    expect(state.contentIds).toEqual([])
    expect(state.contentRecency).toEqual([])
    expect(state.layoutSnapshots).toEqual({})
    expect(dirty).toBe(true)
  })
})
