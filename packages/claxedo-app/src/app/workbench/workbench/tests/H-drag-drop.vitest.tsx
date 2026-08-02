import { afterEach, describe, expect, test } from "vitest"
import { cleanup, fireEvent } from "@solidjs/testing-library"
import { mountWorkbench } from "./dom-helpers"
import { workbenchDrag } from "../pointer-drag"

// Pointer-events drag-and-drop (WP-C3). The native HTML5 DnD input layer was
// replaced by a hand-rolled pointer controller (mouse + touch + pen); the split
// GEOMETRY contract (`computeDropEdge` + `wb.split.split`) is unchanged, so
// these assertions still pin split behavior — only the event synthesis migrated
// from `DragEvent`/`DataTransfer` to pointer events + the shared drag store.

function stubRect(el: Element, width: number, height: number) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
}

/** Route hit-testing (`document.elementFromPoint`) to a chosen element; jsdom's
 *  own implementation always returns null. */
function withElementFromPoint<T>(el: Element, run: () => T): T {
  const original = document.elementFromPoint
  document.elementFromPoint = () => el as Element
  try {
    return run()
  } finally {
    document.elementFromPoint = original
  }
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number; pointerType?: string; button?: number },
) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, "clientX", { value: init.clientX ?? 0 })
  Object.defineProperty(ev, "clientY", { value: init.clientY ?? 0 })
  Object.defineProperty(ev, "pointerId", { value: init.pointerId ?? 1 })
  Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "mouse" })
  Object.defineProperty(ev, "button", { value: init.button ?? 0 })
  target.dispatchEvent(ev)
}

afterEach(() => {
  workbenchDrag.cancel()
  cleanup()
})

describe("H. drag & drop (pointer)", () => {
  test("the pane-drag grip actually receives pointer input (not the dead pointer-events:none wrapper)", () => {
    // WP-C3a regression guard: the drag source was previously attached to the
    // full-pane wrapper, which is `pointer-events:none`, so it could never fire a
    // real pointerdown — the desktop pane-drag path was dead. The source now lives
    // on a small grip (pointer-events:auto) inside a pointer-events:none wrapper.
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    const paneId = h.api().selectors.contentPane("a")!
    const grip = h.utils.queryByTestId(`pane-handle-${paneId}`)! as HTMLElement
    const zone = h.utils.queryByTestId(`pane-handle-zone-${paneId}`)! as HTMLElement

    // The grip (the element carrying the drag source) is hit-testable...
    expect(grip.style.pointerEvents).toBe("auto")
    // ...while its positioning wrapper never intercepts clicks meant for content.
    expect(zone.style.pointerEvents).toBe("none")
  })

  test("dragging the pane handle past threshold begins a drag carrying its contentId", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    const handle = h.utils.queryByTestId(`pane-handle-${h.api().selectors.contentPane("a")!}`)!

    dispatchPointer(handle, "pointerdown", { clientX: 0, clientY: 0 })
    dispatchPointer(window, "pointermove", { clientX: 20, clientY: 0 })

    expect(workbenchDrag.active()).toBe(true)
    expect(workbenchDrag.contentId()).toBe("a")

    dispatchPointer(window, "pointerup", { clientX: 20, clientY: 0 })
    expect(workbenchDrag.active()).toBe(false)
  })

  test("dropping right-edge content adds a horizontal split", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const targetId = h.api().selectors.contentPane("a")!
    const targetPane = h.utils.queryByTestId(`pane-${targetId}`)!
    stubRect(targetPane, 200, 100)

    withElementFromPoint(targetPane, () => {
      workbenchDrag.begin({ contentId: "b", sourceKind: "tab", x: 195, y: 50 })
      workbenchDrag.end()
    })

    expect(h.state().split.root).toMatchObject({ t: "split", dir: "h" })
    expect(h.api().selectors.contentPane("b")).not.toBeNull()
  })

  test("a drop over rendered content routes to its owning pane", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const slot = h.utils.container.querySelector('[data-workbench-content="a"]')!
    stubRect(slot, 200, 100)

    withElementFromPoint(slot, () => {
      workbenchDrag.begin({ contentId: "b", sourceKind: "tab", x: 195, y: 50 })
      workbenchDrag.end()
    })

    expect(h.state().split.root).toMatchObject({ t: "split", dir: "h" })
    expect(h.api().selectors.contentPane("b")).not.toBeNull()
  })

  test("a drop near a pane's middle resolves to the nearest split edge", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    h.api().split.split(p1, "right", "b")
    const p1El = h.utils.queryByTestId(`pane-${p1}`)!
    stubRect(p1El, 200, 200)

    withElementFromPoint(p1El, () => {
      workbenchDrag.begin({ contentId: "b", sourceKind: "tab", x: 100, y: 100 })
      workbenchDrag.end()
    })

    expect(h.state().split.root).toMatchObject({ t: "split", dir: "h" })
    expect(h.api().selectors.contentPane("b")).not.toBeNull()
  })

  test("a self-drop onto the pane's own content is a no-op", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    const p1El = h.utils.queryByTestId(`pane-${p1}`)!
    stubRect(p1El, 200, 200)
    const beforePanes = JSON.stringify(h.state().panes)

    withElementFromPoint(p1El, () => {
      workbenchDrag.begin({ contentId: "a", sourceKind: "tab", x: 100, y: 100 })
      workbenchDrag.end()
    })

    expect(JSON.stringify(h.state().panes)).toBe(beforePanes)
  })

  test("Escape during a drag cancels the drop", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    const p1El = h.utils.queryByTestId(`pane-${p1}`)!
    stubRect(p1El, 200, 100)

    withElementFromPoint(p1El, () => {
      workbenchDrag.begin({ contentId: "b", sourceKind: "tab", x: 195, y: 50 })
      workbenchDrag.move(195, 50)
      fireEvent.keyDown(window, { key: "Escape" })
      // A late pointerup must not resurrect the cancelled drop.
      workbenchDrag.end()
    })

    expect(workbenchDrag.active()).toBe(false)
    expect(h.api().selectors.contentPane("b")).toBeNull()
  })

  test("a drop whose content id is not in the registry is rejected", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    const p1El = h.utils.queryByTestId(`pane-${p1}`)!
    stubRect(p1El, 200, 100)

    withElementFromPoint(p1El, () => {
      workbenchDrag.begin({ contentId: "external-ghost", sourceKind: "tab", x: 195, y: 50 })
      workbenchDrag.end()
    })

    expect(h.state().contentIds).not.toContain("external-ghost")
  })
})
