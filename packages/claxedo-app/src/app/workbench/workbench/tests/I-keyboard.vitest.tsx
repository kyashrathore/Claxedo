import { describe, expect, test, vi } from "vitest"
import { fireEvent } from "@solidjs/testing-library"
import { mountWorkbench } from "./dom-helpers"

describe("I. keyboard", () => {
  // mod+\ / mod+shift+\ split the focused pane by revealing the most-recent
  // hidden surface beside it (core-panes-split-tabs:591). The prior handler
  // passed the focused pane's own contentId into split(), which the self-drop
  // guard always rejected, so the chord was dead. The model holds one content
  // per pane, so a keyboard split brings a background surface into view.
  test("mod+\\ splits the focused pane to the right, revealing the MRU hidden surface", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    h.api().contents.add("b") // background surface, not bound to any pane
    expect(h.state().panes).toHaveLength(1)

    fireEvent.keyDown(window, { key: "\\", metaKey: true })

    expect(h.state().panes).toHaveLength(2)
    // "b" is now bound to the newly created (focused) pane.
    expect(h.api().selectors.contentPane("b")).toBe(h.state().focusedPaneId)
  })

  test("mod+shift+\\ splits the focused pane downward", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    h.api().contents.add("b")

    fireEvent.keyDown(window, { key: "\\", metaKey: true, shiftKey: true })

    expect(h.state().panes).toHaveLength(2)
    expect(h.state().split.root?.t).toBe("split")
    if (h.state().split.root?.t === "split") {
      expect(h.state().split.root.dir).toBe("v") // vertical stack = bottom edge
    }
  })

  test("mod+\\ is a no-op when there is no hidden surface to reveal", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    fireEvent.keyDown(window, { key: "\\", metaKey: true })
    expect(h.state().panes).toHaveLength(1)
  })

  test("mod+w closes the focused pane without removing content", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    h.api().split.split(h.api().selectors.contentPane("a")!, "right", "b")
    // focused = b's pane
    fireEvent.keyDown(window, { key: "w", metaKey: true })
    expect(h.state().panes).toHaveLength(1)
    expect(h.state().contentIds).toContain("b")
    expect(h.api().selectors.contentPane("b")).toBeNull()
  })

  test("mod+w delegates the focused pane and content to shell close policy", () => {
    const onCloseFocusedPane = vi.fn()
    const h = mountWorkbench({ onCloseFocusedPane })
    h.api().contents.add("a")
    h.api().navigation.show("a")

    fireEvent.keyDown(window, { key: "w", metaKey: true })

    expect(onCloseFocusedPane).toHaveBeenCalledWith(h.state().focusedPaneId, "a")
    expect(h.state().panes).toHaveLength(1)
    expect(h.state().contentIds).toContain("a")
  })

  test("mod+w remains a global pane shortcut while focus is inside an editor", () => {
    const onCloseFocusedPane = vi.fn()
    const h = mountWorkbench({
      onCloseFocusedPane,
      renderContent: () => <textarea aria-label="Composer" />,
    })
    h.api().contents.add("a")
    h.api().navigation.show("a")

    fireEvent.keyDown(h.utils.getByRole("textbox", { name: "Composer" }), { key: "w", metaKey: true })

    expect(onCloseFocusedPane).toHaveBeenCalledWith(h.state().focusedPaneId, "a")
  })

  test("mod+w does not double-close when an inner command already handled it", () => {
    const onCloseFocusedPane = vi.fn()
    const h = mountWorkbench({ onCloseFocusedPane })
    h.api().contents.add("a")
    h.api().navigation.show("a")
    const event = new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true, cancelable: true })
    event.preventDefault()

    window.dispatchEvent(event)

    expect(onCloseFocusedPane).not.toHaveBeenCalled()
  })

  test("a custom close binding does not replace native editor shortcuts", () => {
    const onCloseFocusedPane = vi.fn()
    const h = mountWorkbench({
      keyMap: { closePane: "mod+x" },
      onCloseFocusedPane,
      renderContent: () => <textarea aria-label="Composer" />,
    })
    h.api().contents.add("a")
    h.api().navigation.show("a")

    fireEvent.keyDown(h.utils.getByRole("textbox", { name: "Composer" }), { key: "x", metaKey: true })

    expect(onCloseFocusedPane).not.toHaveBeenCalled()
  })

  test("pane close control closes that pane without removing content", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    h.api().split.split(h.api().selectors.contentPane("a")!, "right", "b")
    const paneId = h.api().selectors.contentPane("b")!
    fireEvent.click(h.utils.getByTestId(`pane-close-${paneId}`))
    expect(h.state().panes).toHaveLength(1)
    expect(h.state().contentIds).toContain("b")
    expect(h.api().selectors.contentPane("b")).toBeNull()
  })

  test("pane close control is hidden for a single pane", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    const paneId = h.api().selectors.contentPane("a")!
    expect(h.utils.queryByTestId(`pane-close-${paneId}`)).toBeNull()
  })

  test("mod+alt+ArrowLeft focuses the pane to the left of the current one", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    h.api().split.split(h.api().selectors.contentPane("a")!, "right", "b")
    fireEvent.keyDown(window, { key: "ArrowLeft", metaKey: true, altKey: true })
    expect(h.state().focusedPaneId).toBe(h.api().selectors.contentPane("a")!)
  })

  test("resize divider exposes separator ARIA and supports arrow-key resize", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    h.api().contents.add("b")
    h.api().split.split(h.api().selectors.contentPane("a")!, "right", "b")

    const divider = h.utils.getByTestId("workbench-divider")
    expect(divider.getAttribute("role")).toBe("separator")
    expect(divider.getAttribute("aria-orientation")).toBe("vertical")
    expect(divider.getAttribute("tabindex")).toBe("0")
    expect(divider.getAttribute("aria-label")).toBe("Resize panes")
    expect(divider.getAttribute("aria-valuenow")).toBe("50")

    const rootBefore = h.state().split.root
    const sizeBefore = rootBefore?.t === "split" ? rootBefore.size : 0
    fireEvent.keyDown(divider, { key: "ArrowRight" })
    const rootAfter = h.state().split.root
    const sizeAfter = rootAfter?.t === "split" ? rootAfter.size : 0
    expect(sizeAfter).toBeGreaterThan(sizeBefore)
    // One ArrowRight steps the ratio by exactly KEYBOARD_STEP (0.02): 0.50 → 0.52.
    expect(sizeAfter).toBeCloseTo(0.52, 5)
    // aria-valuenow tracks the live ratio at the pinned magnitude.
    expect(divider.getAttribute("aria-valuenow")).toBe("52")

    // ArrowLeft moves it back.
    fireEvent.keyDown(divider, { key: "ArrowLeft" })
    const rootBack = h.state().split.root
    const sizeBack = rootBack?.t === "split" ? rootBack.size : 0
    expect(sizeBack).toBeCloseTo(sizeBefore, 5)
  })

  test("custom keyMap overrides defaults", () => {
    const h = mountWorkbench({ keyMap: { closePane: "mod+x" } })
    h.api().contents.add("a")
    h.api().navigation.show("a")
    fireEvent.keyDown(window, { key: "x", metaKey: true })
    expect(h.state().panes).toHaveLength(0)
  })
})
