import { describe, expect, test } from "vitest"
import { fireEvent } from "@solidjs/testing-library"
import { mountWorkbench } from "./dom-helpers"

describe("P. click focus", () => {
  test("mousedown inside the unfocused pane's content focuses that pane", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const paneA = h.api().selectors.contentPane("a")!
    h.api().split.split(paneA, "right", "b")
    const paneB = h.api().selectors.contentPane("b")!
    expect(h.state().focusedPaneId).toBe(paneB)

    fireEvent.mouseDown(h.utils.getByTestId("content-a"))
    expect(h.state().focusedPaneId).toBe(paneA)

    fireEvent.mouseDown(h.utils.getByTestId("content-b"))
    expect(h.state().focusedPaneId).toBe(paneB)
  })
})
