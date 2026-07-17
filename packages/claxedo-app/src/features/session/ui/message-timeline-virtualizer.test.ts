import { expect, test } from "bun:test"
import { Virtualizer } from "@tanstack/solid-virtual"

// Guards the patched @tanstack/virtual-core (patches/@tanstack%2Fvirtual-core@3.17.3.patch)
// behavior that message-timeline.tsx relies on via `anchorTo: "end"`.
// Ported from upstream packages/app/test-browser/solid-virtual.test.ts (#36160).

test("end anchoring survives consecutive resizes when the first scroll write is clamped", () => {
  const writes: { offset: number; adjustments?: number }[] = []
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 5,
    estimateSize: () => 50,
    initialOffset: 50,
    initialRect: { width: 400, height: 200 },
    anchorTo: "end",
    scrollEndThreshold: 1,
    getScrollElement: () => null,
    scrollToFn: (offset, options) => writes.push({ offset, adjustments: options.adjustments }),
    observeElementRect: () => {},
    observeElementOffset: () => {},
  })

  virtualizer.getTotalSize()
  virtualizer.resizeItem(4, 120)
  expect(writes).toEqual([{ offset: 50, adjustments: 70 }])
  writes.length = 0

  virtualizer.resizeItem(4, 200)
  expect(writes).toEqual([{ offset: 120, adjustments: 80 }])
})

test("clamps oversized offsets with scroll margin and padding changes", () => {
  const options = (paddingEnd: number) => ({
    count: 20,
    estimateSize: () => 60,
    initialOffset: Number.MAX_SAFE_INTEGER,
    initialRect: { width: 800, height: 600 },
    scrollMargin: 64,
    paddingEnd,
    overscan: 1,
    getScrollElement: () => null,
    scrollToFn: () => {},
    observeElementRect: () => {},
    observeElementOffset: () => {},
  })
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>(options(64))

  expect(virtualizer.getVirtualItems().map((item) => item.index)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

  virtualizer.setOptions(options(600))
  expect(virtualizer.getVirtualItems().map((item) => item.index)).toEqual([18, 19])
})
