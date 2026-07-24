import type { Virtualizer } from "@tanstack/solid-virtual"

export const TIMELINE_OVERSCAN = 3

export function filterVirtualIndexes(indexes: number[], count: number) {
  return indexes.filter((index) => index >= 0 && index < count)
}

export function scheduleConnectedMeasure<T extends HTMLElement>(element: T, measure: (element: T) => void) {
  return requestAnimationFrame(() => {
    if (element.isConnected) measure(element)
  })
}

export function createTimelineResizeAnchor() {
  let pinnedIndexes: number[] = []
  let pinFrame: number | undefined
  let anchorScheduled = false

  return {
    pinnedIndexes: () => pinnedIndexes,
    install(input: {
      virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
      root: () => HTMLDivElement | undefined
      shouldAnchorBottom: () => boolean
      hasScrollGesture: () => boolean
    }) {
      input.virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
        if (input.shouldAnchorBottom()) return false
        const first = input.virtualizer.range?.startIndex
        return first !== undefined && item.index < first
      }

      const resizeItem = input.virtualizer.resizeItem.bind(input.virtualizer)
      const anchorBottom = () => {
        if (anchorScheduled || input.hasScrollGesture()) return
        anchorScheduled = true
        queueMicrotask(() => {
          anchorScheduled = false
          if (!input.shouldAnchorBottom() || input.hasScrollGesture()) return
          input.virtualizer.scrollToEnd()
        })
      }

      input.virtualizer.resizeItem = (index: number, size: number) => {
        const item = input.virtualizer.measurementsCache[index]
        const previous = item ? (input.virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
        const root = input.root()
        if (root && previous !== undefined && Math.abs(size - previous) > root.clientHeight) {
          const view = root.getBoundingClientRect()
          pinnedIndexes = [...root.querySelectorAll<HTMLElement>("[data-index]")]
            .filter((element) => {
              const rect = element.getBoundingClientRect()
              return rect.bottom > view.top && rect.top < view.bottom
            })
            .map((element) => Number(element.dataset.index))
          if (pinFrame !== undefined) cancelAnimationFrame(pinFrame)
          pinFrame = requestAnimationFrame(() => {
            pinFrame = requestAnimationFrame(() => {
              pinFrame = undefined
              pinnedIndexes = []
            })
          })
        }
        resizeItem(index, size)
        if (root && input.shouldAnchorBottom()) anchorBottom()
      }
    },
    dispose() {
      if (pinFrame !== undefined) cancelAnimationFrame(pinFrame)
    },
  }
}
