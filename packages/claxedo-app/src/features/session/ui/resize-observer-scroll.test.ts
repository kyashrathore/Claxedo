import { describe, expect, test } from "bun:test"
import { createPromptDockResizeHandler } from "./resize-observer-scroll"

describe("createPromptDockResizeHandler", () => {
  test("defers and coalesces scroll work outside ResizeObserver delivery", () => {
    const callbacks: FrameRequestCallback[] = []
    const scrollStates: HTMLDivElement[] = []
    let historyFills = 0
    let scrolls = 0
    const scroller = { scrollHeight: 1_000, clientHeight: 500, scrollTop: 500 } as HTMLDivElement
    const handler = createPromptDockResizeHandler({
      scroller: () => scroller,
      userScrolled: () => false,
      scrollToEnd: () => scrolls++,
      scheduleScrollState: (element) => scrollStates.push(element),
      scheduleHistoryFill: () => historyFills++,
      requestFrame: (callback) => {
        callbacks.push(callback)
        return callbacks.length
      },
      cancelFrame: () => {},
    })

    handler.resize(120.1)
    handler.resize(121.1)

    expect(scrolls).toBe(0)
    expect(callbacks).toHaveLength(1)
    expect(scrollStates).toEqual([scroller, scroller])
    expect(historyFills).toBe(2)

    callbacks[0](0)

    expect(scrolls).toBe(1)

    handler.resize(123)
    expect(callbacks).toHaveLength(2)
  })

  test("cancels pending work when disposed", () => {
    const cancelled: number[] = []
    let scrolls = 0
    const handler = createPromptDockResizeHandler({
      scroller: () => ({ scrollHeight: 1_000, clientHeight: 500, scrollTop: 500 }) as HTMLDivElement,
      userScrolled: () => false,
      scrollToEnd: () => scrolls++,
      scheduleScrollState: () => {},
      scheduleHistoryFill: () => {},
      requestFrame: () => 42,
      cancelFrame: (frame) => cancelled.push(frame),
    })

    handler.resize(120)
    handler.dispose()
    handler.resize(121)

    expect(cancelled).toEqual([42])
    expect(scrolls).toBe(0)
  })

  test("does not auto-scroll a user who is away from the bottom", () => {
    let frames = 0
    const handler = createPromptDockResizeHandler({
      scroller: () => ({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 100 }) as HTMLDivElement,
      userScrolled: () => true,
      scrollToEnd: () => {},
      scheduleScrollState: () => {},
      scheduleHistoryFill: () => {},
      requestFrame: () => ++frames,
      cancelFrame: () => {},
    })

    handler.resize(120)

    expect(frames).toBe(0)
  })
})
