import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup } from "@solidjs/testing-library"
import { mountWorkbench, sleep } from "./dom-helpers"

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

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

  test("onPaneResize emits each pane's latest geometry once per animation frame", () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrame
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 1000, 600))
    const flush = () => {
      const pending = [...frames.values()]
      frames.clear()
      for (const frame of pending) frame(16)
    }
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const left = h.api().selectors.contentPane("a")!
    h.api().split.split(left, "right", "b")
    const right = h.api().selectors.contentPane("b")!
    flush()
    h.resizeEvents.length = 0

    for (let i = 0; i < 100; i++) h.api().split.resize([], 0.5 + i * 0.001)
    expect(h.resizeEvents).toEqual([])
    flush()
    expect(h.resizeEvents).toHaveLength(2)
    expect(h.resizeEvents.map((event) => event.paneId)).toEqual([left, right])
    expect(h.resizeEvents[0].rect.left).toBe(0)
    expect(h.resizeEvents[0].rect.width).toBeCloseTo(599)
    expect(h.resizeEvents[1].rect.left).toBeCloseTo(599)
    expect(h.resizeEvents[1].rect.width).toBeCloseTo(401)
    expect(h.resizeEvents.every((event) => event.rect.top === 0 && event.rect.height === 600)).toBe(true)

    flush()
    expect(h.resizeEvents).toHaveLength(2)
    h.api().split.resize([], 0.7)
    flush()
    expect(h.resizeEvents).toHaveLength(4)
    expect(h.resizeEvents[2].rect.width).toBeCloseTo(700)
    expect(h.resizeEvents[3].rect.width).toBeCloseTo(300)
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
