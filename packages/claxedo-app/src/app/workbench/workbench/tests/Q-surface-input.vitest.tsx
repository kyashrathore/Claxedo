import { describe, expect, test } from "vitest"
import { fireEvent } from "@solidjs/testing-library"
import { mountWorkbench } from "./dom-helpers"
import type { PaneCtx } from "../workbench"

/**
 * Q. Input that arrives at the window (keys with nothing focused) or at a
 * point (a file drop) is the workbench's to route: it forwards keys to the
 * shown surface of the focused pane and gives every surface its own slot
 * element to bind pointer input to. A surface never listens on `document`.
 */
describe("Q. surface input", () => {
  function harness() {
    const seen: string[] = []
    const h = mountWorkbench({
      renderContent: (id: string, ctx: PaneCtx) => {
        ctx.onKeyDown((event) => seen.push(`${id}:${event.key}`))
        return <div data-testid={`content-${id}`}>{id}</div>
      },
    })
    return { h, seen }
  }

  test("a key with nothing focused reaches only the focused pane's surface", () => {
    const { h, seen } = harness()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    h.api().split.split(h.api().selectors.contentPane("a")!, "right", "b")
    // focused = b's pane

    fireEvent.keyDown(window, { key: "x" })
    expect(seen).toEqual(["b:x"])

    h.api().split.focus(h.api().selectors.contentPane("a")!)
    fireEvent.keyDown(window, { key: "y" })
    expect(seen).toEqual(["b:x", "a:y"])
  })

  test("a retained hidden tab in the focused pane hears nothing", () => {
    const { h, seen } = harness()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    h.api().navigation.show("b") // a is retained hidden in the same pane
    expect(document.querySelector('[data-workbench-content="a"]')).not.toBeNull()

    fireEvent.keyDown(window, { key: "x" })
    expect(seen).toEqual(["b:x"])
  })

  test("a workbench chord is not forwarded to the surface", () => {
    const { h, seen } = harness()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")

    fireEvent.keyDown(window, { key: "\\", metaKey: true })
    expect(h.state().panes).toHaveLength(2)
    expect(seen).toEqual([])
  })

  test("a surface's subscription ends with the surface", () => {
    const { h, seen } = harness()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    fireEvent.keyDown(window, { key: "x" })
    expect(seen).toEqual(["a:x"])

    h.api().contents.remove("a")
    fireEvent.keyDown(window, { key: "y" })
    expect(seen).toEqual(["a:x"])
  })

  test("each surface gets its own slot element and a hidden slot takes no pointer input", () => {
    const elements = new Map<string, () => HTMLDivElement | undefined>()
    const h = mountWorkbench({
      renderContent: (id: string, ctx: PaneCtx) => {
        elements.set(id, ctx.element)
        return <div>{id}</div>
      },
    })
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    h.api().navigation.show("b")

    const a = elements.get("a")?.()
    const b = elements.get("b")?.()
    expect(a?.getAttribute("data-workbench-content")).toBe("a")
    expect(b?.getAttribute("data-workbench-content")).toBe("b")
    expect(a?.style.pointerEvents).toBe("none")
    expect(a?.inert).toBe(true)
    expect(b?.style.pointerEvents).not.toBe("none")
  })

  test("with no focused pane, no surface hears a key", () => {
    const { h, seen } = harness()
    h.api().contents.add("a")
    fireEvent.keyDown(window, { key: "x" }) // nothing shown yet
    expect(seen).toEqual([])
    expect(h.state().focusedPaneId).toBeNull()
  })
})
