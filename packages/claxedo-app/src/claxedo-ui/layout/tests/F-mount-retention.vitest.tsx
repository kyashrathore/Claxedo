import { describe, expect, test } from "vitest"
import { mountWorkbench } from "./dom-helpers"

describe("F. mount retention", () => {
  test("navigating from A to B does not unmount A's renderContent", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    expect(h.utils.queryByTestId("content-a")).not.toBeNull()
    h.api().contents.add("b")
    h.api().navigation.show("b")
    expect(h.utils.queryByTestId("content-a")).not.toBeNull()
    expect(h.utils.queryByTestId("content-a")?.getAttribute("data-visible")).toBe("0")
    expect(h.utils.queryByTestId("content-b")?.getAttribute("data-visible")).toBe("1")
  })

  test("after a navigate-restore cycle, hidden content has its DOM intact", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const aRoot = h.utils.queryByTestId("content-a")!
    ;(aRoot as HTMLElement).dataset.markedByTest = "yes"
    h.api().split.split(h.api().selectors.contentPane("a")!, "right", "b")
    h.api().navigation.show("b")
    expect((h.utils.queryByTestId("content-a") as HTMLElement)?.dataset.markedByTest).toBe("yes")
    h.api().navigation.show("a")
    expect((h.utils.queryByTestId("content-a") as HTMLElement)?.dataset.markedByTest).toBe("yes")
  })

  test('mountPolicy="active-only" unmounts hidden content', () => {
    const h = mountWorkbench({ mountPolicy: "active-only" })
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    h.api().navigation.show("b")
    expect(h.utils.queryByTestId("content-a")).toBeNull()
  })

  test("paneCtx.isVisible reflects whether the pane is currently displaying this content", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    h.api().navigation.show("b")
    expect(h.utils.queryByTestId("content-a")?.getAttribute("data-visible")).toBe("0")
    expect(h.utils.queryByTestId("content-b")?.getAttribute("data-visible")).toBe("1")
  })
})
