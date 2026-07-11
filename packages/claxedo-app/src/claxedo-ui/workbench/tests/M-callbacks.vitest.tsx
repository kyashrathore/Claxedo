import { describe, expect, test } from "vitest"
import { mountWorkbench, sleep } from "./dom-helpers"

describe("M. callbacks", () => {
  test("onContentOpen fires when content enters a pane", async () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    await sleep(0)
    expect(h.openEvents).toContainEqual({ contentId: "a", paneId: h.api().selectors.contentPane("a")! })
  })

  test("onContentClose fires with reason='user' for explicit close", async () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    h.api().contents.remove("a")
    await sleep(0)
    expect(h.closeEvents).toContainEqual({ contentId: "a", reason: "user" })
  })

  test("onPaneResize is throttled (does not fire faster than 60Hz)", async () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    h.api().split.split(h.api().selectors.contentPane("a")!, "right", "b")
    h.resizeEvents.length = 0
    for (let i = 0; i < 100; i++) h.api().split.resize([], 0.5 + i * 0.001)
    await sleep(50)
    // Throttled to <= ~4 emits per pane in 50ms (RAF ~60Hz, so each pane: ~3 frames).
    // Two panes → up to ~8 events total; bound to 16 to be safe given test variance.
    expect(h.resizeEvents.length).toBeLessThanOrEqual(16)
  })

  test("onFocusChange fires with paneId+contentId when split focuses new pane", async () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    h.api().split.split(p1, "right", "b")
    await sleep(0)
    const last = h.focusEvents.at(-1)
    expect(last?.paneId).toBe(h.api().selectors.contentPane("b")!)
    expect(last?.contentId).toBe("b")
  })
})
