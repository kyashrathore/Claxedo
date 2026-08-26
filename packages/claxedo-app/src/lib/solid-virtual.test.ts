import { expect, test } from "bun:test"
import { createRoot, flush } from "solid-js"
import { createVirtualizer } from "./solid-virtual"

// peekVirtualItems is the untracked lane for event handlers: it must expose
// the same window as the reactive store without wrapping rows in store proxies,
// and it must reflect a measurement immediately, before any reactive flush.
test("peekVirtualItems bypasses the reactive store but sees the same window", () => {
  createRoot((dispose) => {
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: 20,
      estimateSize: () => 60,
      initialRect: { width: 800, height: 600 },
      getScrollElement: () => null,
      scrollToFn: () => {},
      observeElementRect: () => {},
      observeElementOffset: () => {},
    })
    flush()

    const tracked = virtualizer.getVirtualItems()
    const peeked = virtualizer.peekVirtualItems()
    expect(peeked.map((item) => item.index)).toEqual(tracked.map((item) => item.index))
    // The store hands out proxy-wrapped rows; the peek lane hands out the
    // core's own plain objects.
    expect(peeked[0]).not.toBe(tracked[0])

    virtualizer.resizeItem(0, 200)
    expect(virtualizer.peekVirtualItems()[1]?.start).toBe(200)

    dispose()
  })
})
