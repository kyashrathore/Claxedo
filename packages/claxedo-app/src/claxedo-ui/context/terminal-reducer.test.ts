import { describe, expect, test } from "bun:test"
import { reduceTerminalTab, type Pane, type TerminalTabState } from "./terminal-reducer"

const leaf = (id: string) => ({ t: "leaf" as const, id })
const split = (a: Pane, b: Pane, dir: "h" | "v" = "v") => ({ t: "split" as const, dir, a, b, size: 0.5 })

describe("ensure action", () => {
  test("creates a leaf pane and focuses it when state is empty", () => {
    const state: TerminalTabState = { pane: undefined, focus: undefined, zoom: undefined }
    const next = reduceTerminalTab(state, { type: "ensure", id: "a" })
    expect(next.pane).toEqual(leaf("a"))
    expect(next.focus).toBe("a")
  })

  test("is a no-op when pane already exists", () => {
    const state: TerminalTabState = { pane: leaf("a"), focus: "a", zoom: undefined }
    const next = reduceTerminalTab(state, { type: "ensure", id: "b" })
    expect(next).toBe(state)
  })
})

describe("set_focus and set_zoom actions", () => {
  test("set_focus updates focus only", () => {
    const state: TerminalTabState = { pane: leaf("a"), focus: "a", zoom: "a" }
    const next = reduceTerminalTab(state, { type: "set_focus", id: "b" })
    expect(next.focus).toBe("b")
    expect(next.zoom).toBe("a")
  })

  test("set_zoom updates zoom and supports clearing", () => {
    const state: TerminalTabState = { pane: leaf("a"), focus: "a", zoom: "a" }
    const withZoom = reduceTerminalTab(state, { type: "set_zoom", id: "b" })
    const cleared = reduceTerminalTab(withZoom, { type: "set_zoom", id: undefined })
    expect(withZoom.zoom).toBe("b")
    expect(cleared.zoom).toBeUndefined()
  })
})

describe("focus and zoom actions", () => {
  test("focus sets focus and clears zoom", () => {
    const state: TerminalTabState = { pane: split(leaf("a"), leaf("b")), focus: "a", zoom: "a" }
    const next = reduceTerminalTab(state, { type: "focus", id: "b" })
    expect(next.focus).toBe("b")
    expect(next.zoom).toBeUndefined()
  })

  test("zoom toggles current zoom id", () => {
    const state: TerminalTabState = { pane: split(leaf("a"), leaf("b")), focus: "a", zoom: undefined }
    const zoomed = reduceTerminalTab(state, { type: "zoom", id: "a" })
    const unzoomed = reduceTerminalTab(zoomed, { type: "zoom", id: "a" })
    expect(zoomed.zoom).toBe("a")
    expect(unzoomed.zoom).toBeUndefined()
  })
})

describe("split action", () => {
  test("creates initial split when pane is empty", () => {
    const state: TerminalTabState = { pane: undefined, focus: undefined, zoom: undefined }
    const next = reduceTerminalTab(state, { type: "split", at: "a", id: "b", dir: "h" })
    expect(next.pane).toEqual({ t: "split", dir: "h", a: leaf("a"), b: leaf("b"), size: 0.5 })
    expect(next.focus).toBe("b")
  })

  test("splits at the requested existing leaf", () => {
    const state: TerminalTabState = { pane: split(leaf("a"), leaf("c")), focus: "a", zoom: undefined }
    const next = reduceTerminalTab(state, { type: "split", at: "a", id: "b", dir: "v" })
    expect(next.pane).toEqual(split({ t: "split", dir: "v", a: leaf("a"), b: leaf("b"), size: 0.5 }, leaf("c")))
    expect(next.focus).toBe("b")
  })

  test("falls back to first leaf when target leaf is missing", () => {
    const state: TerminalTabState = { pane: split(leaf("a"), leaf("c")), focus: "a", zoom: undefined }
    const next = reduceTerminalTab(state, { type: "split", at: "missing", id: "b", dir: "v" })
    expect(next.pane).toEqual(split({ t: "split", dir: "v", a: leaf("a"), b: leaf("b"), size: 0.5 }, leaf("c")))
    expect(next.focus).toBe("b")
  })
})

describe("close and detach actions", () => {
  test("close removes pane and updates focus and zoom when needed", () => {
    const state: TerminalTabState = { pane: split(leaf("a"), leaf("b")), focus: "a", zoom: "a" }
    const next = reduceTerminalTab(state, { type: "close", id: "a" })
    expect(next.pane).toEqual(leaf("b"))
    expect(next.focus).toBe("b")
    expect(next.zoom).toBeUndefined()
  })

  test("detach is equivalent to close", () => {
    const state: TerminalTabState = { pane: split(leaf("a"), leaf("b")), focus: "b", zoom: undefined }
    const next = reduceTerminalTab(state, { type: "detach", id: "b" })
    expect(next.pane).toEqual(leaf("a"))
    expect(next.focus).toBe("a")
  })
})

describe("resize action", () => {
  test("is a no-op without a split pane", () => {
    const state: TerminalTabState = { pane: leaf("a"), focus: "a", zoom: undefined }
    const next = reduceTerminalTab(state, { type: "resize", path: "", size: 0.8 })
    expect(next).toBe(state)
  })

  test("resizes root and clamps to sane range", () => {
    const state: TerminalTabState = { pane: split(leaf("a"), leaf("b")), focus: "a", zoom: undefined }
    const next = reduceTerminalTab(state, { type: "resize", path: "", size: 10 })
    expect(next.pane).toEqual({ t: "split", dir: "v", a: leaf("a"), b: leaf("b"), size: 0.9 })
  })

  test("resizes nested split by path", () => {
    const state: TerminalTabState = { pane: split(split(leaf("a"), leaf("b")), leaf("c")), focus: "a", zoom: undefined }
    const next = reduceTerminalTab(state, { type: "resize", path: "a", size: 0.3 })
    expect(next.pane).toEqual(split({ t: "split", dir: "v", a: leaf("a"), b: leaf("b"), size: 0.3 }, leaf("c")))
  })
})

describe("swap action", () => {
  test("swaps two leaf ids and focus/zoom ownership", () => {
    const state: TerminalTabState = { pane: split(leaf("a"), leaf("b")), focus: "a", zoom: "b" }
    const next = reduceTerminalTab(state, { type: "swap", a: "a", b: "b" })
    expect(next.pane).toEqual(split(leaf("b"), leaf("a")))
    expect(next.focus).toBe("b")
    expect(next.zoom).toBe("a")
  })

  test("is a no-op for identical or missing ids", () => {
    const state: TerminalTabState = { pane: split(leaf("a"), leaf("b")), focus: "a", zoom: undefined }
    const same = reduceTerminalTab(state, { type: "swap", a: "a", b: "a" })
    const missing = reduceTerminalTab(state, { type: "swap", a: "a", b: "x" })
    expect(same).toBe(state)
    expect(missing).toBe(state)
  })
})

describe("replaceId action", () => {
  test("replaces leaf ID in a single-node pane", () => {
    const state: TerminalTabState = { pane: leaf("old"), focus: "old", zoom: undefined }
    const next = reduceTerminalTab(state, { type: "replaceId", oldId: "old", newId: "new" })
    expect(next.pane).toEqual(leaf("new"))
  })

  test("replaces leaf ID deep in a split tree", () => {
    const pane = split(split(leaf("a"), leaf("old")), leaf("c"))
    const state: TerminalTabState = { pane, focus: "a", zoom: undefined }
    const next = reduceTerminalTab(state, { type: "replaceId", oldId: "old", newId: "new" })
    expect(next.pane).toEqual(split(split(leaf("a"), leaf("new")), leaf("c")))
    if (next.pane?.t === "split" && state.pane?.t === "split") {
      expect(next.pane.b).toBe(state.pane.b)
    }
  })

  test("updates focus and zoom when they match oldId", () => {
    const state: TerminalTabState = { pane: leaf("old"), focus: "old", zoom: "old" }
    const next = reduceTerminalTab(state, { type: "replaceId", oldId: "old", newId: "new" })
    expect(next.focus).toBe("new")
    expect(next.zoom).toBe("new")
  })

  test("returns same state reference when oldId not found", () => {
    const state: TerminalTabState = { pane: leaf("other"), focus: "other", zoom: undefined }
    const next = reduceTerminalTab(state, { type: "replaceId", oldId: "old", newId: "new" })
    expect(next).toBe(state)
  })
})
