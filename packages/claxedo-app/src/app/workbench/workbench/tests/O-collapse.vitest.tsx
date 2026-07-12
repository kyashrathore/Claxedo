// O. Narrow-viewport collapse (single-pane projection).
//
// Guards the VIEW wiring the pure `collapse-projection.test.ts` cannot: that a
// workbench whose measured canvas width is below BP_MD renders exactly ONE pane
// (the focused one) full-bleed, hides the rest via `display:none` WITHOUT
// touching state (splits preserved-but-hidden), drops the resize divider, and
// swaps the visible pane when focus moves — the projection re-driving the DOM
// off `focusedPaneId` alone, no reducer involved.
//
// Width is injected by stubbing `getBoundingClientRect` (jsdom reports 0 and has
// no ResizeObserver), so the workbench's own onMount measure reads the narrow
// width and the `collapsed` memo latches on.

import { afterEach, describe, expect, test } from "vitest"
import { cleanup } from "@solidjs/testing-library"
import { mountWorkbench } from "./dom-helpers"
import { BP_MD } from "../collapse-projection"

type RectFn = typeof Element.prototype.getBoundingClientRect

function stubCanvasWidth(width: number): () => void {
  const proto = Element.prototype
  const original: RectFn = proto.getBoundingClientRect
  proto.getBoundingClientRect = function stubbed(this: Element): DOMRect {
    return {
      width,
      height: 800,
      top: 0,
      left: 0,
      right: width,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
  return () => {
    proto.getBoundingClientRect = original
  }
}

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
  cleanup()
})

function paneDiv(h: ReturnType<typeof mountWorkbench>, paneId: string): HTMLElement {
  return h.utils.getByTestId(`pane-${paneId}`)
}

describe("O. narrow-viewport collapse", () => {
  test("below BP_MD only the focused pane is visible; the split is preserved in state", () => {
    restore = stubCanvasWidth(390)
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    h.api().split.split(p1, "right", "b")
    const p2 = h.api().selectors.contentPane("b")!

    const focused = h.state().focusedPaneId!
    const hidden = focused === p1 ? p2 : p1

    // The state still holds a real two-pane split — collapse is projection-only.
    expect(h.state().split.root).toMatchObject({ t: "split" })
    expect(h.state().panes).toHaveLength(2)

    // Exactly one pane paints; the other is display:none.
    expect(paneDiv(h, focused).style.display).not.toBe("none")
    expect(paneDiv(h, hidden).style.display).toBe("none")

    // No resize divider in single-pane mode.
    expect(h.utils.queryByTestId("workbench-divider")).toBeNull()
  })

  test("moving focus swaps which pane is visible with no state reshape", () => {
    restore = stubCanvasWidth(390)
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    h.api().split.split(p1, "right", "b")
    const p2 = h.api().selectors.contentPane("b")!

    const splitBefore = JSON.stringify(h.state().split)

    h.api().split.focus(p1)
    expect(paneDiv(h, p1).style.display).not.toBe("none")
    expect(paneDiv(h, p2).style.display).toBe("none")

    h.api().split.focus(p2)
    expect(paneDiv(h, p2).style.display).not.toBe("none")
    expect(paneDiv(h, p1).style.display).toBe("none")

    // The visible-pane swap wrote nothing to the split geometry.
    expect(JSON.stringify(h.state().split)).toBe(splitBefore)
  })

  test("at or above BP_MD both panes render and the divider returns", () => {
    restore = stubCanvasWidth(BP_MD + 200)
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    h.api().split.split(p1, "right", "b")
    const p2 = h.api().selectors.contentPane("b")!

    expect(paneDiv(h, p1).style.display).not.toBe("none")
    expect(paneDiv(h, p2).style.display).not.toBe("none")
    expect(h.utils.queryByTestId("workbench-divider")).not.toBeNull()
  })
})
