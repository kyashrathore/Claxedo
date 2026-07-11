import { describe, expect, test } from "vitest"
import { fireEvent } from "@solidjs/testing-library"
import { mountWorkbench } from "./dom-helpers"

describe("I. keyboard", () => {
  // mod+\ / mod+shift+\ split shortcuts were removed entirely (2026-07-10): the
  // handler could only ever pass the focused pane's own contentId into split(),
  // which the self-drop guard rejects, so the binding was dead since inception.
  test("mod+\\ is unbound and never mutates the layout", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    fireEvent.keyDown(window, { key: "\\", metaKey: true })
    fireEvent.keyDown(window, { key: "\\", metaKey: true, shiftKey: true })
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

  test("custom keyMap overrides defaults", () => {
    const h = mountWorkbench({ keyMap: { closePane: "mod+x" } })
    h.api().contents.add("a")
    h.api().navigation.show("a")
    fireEvent.keyDown(window, { key: "x", metaKey: true })
    expect(h.state().panes).toHaveLength(0)
  })
})
