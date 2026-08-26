import type { Virtualizer } from "@tanstack/virtual-core"

export function estimateLongMarkdownHeight(text: string) {
  let lineCount = 1
  for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", newline + 1)) lineCount += 1
  // Neither supported estimate can match fewer than 20 structural rows. Avoid
  // allocating a line array and running a regex for the overwhelmingly common
  // one-line response while the virtualizer estimates the complete history.
  if (lineCount < 20) return

  const lines = text.split("\n")
  if (/^\s*(?:```|~~~)/.test(lines[0] ?? "") && lines.length > 80) {
    return Math.min(6_000, (lines.length - 2) * 24 + 36)
  }
  let structuralRows = 0
  for (const line of lines) {
    if (!/^\s*(?:[-*+]\s+|\|)/.test(line)) continue
    structuralRows += 1
    if (structuralRows >= 20) return Math.min(6_000, lines.length * 50)
  }
}

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
      /**
       * Whether this timeline's surface is the one being shown. A stashed
       * surface stays mounted under a display lock, where `scrollToEnd` cannot
       * land: the virtualizer's own scroll reconcile then re-arms itself every
       * frame until its multi-second safety valve, once per retained session.
       * The re-anchor is worthless while nothing is painted anyway — the
       * surface re-anchors on its way back in.
       */
      displayed: () => boolean
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
        if (anchorScheduled || input.hasScrollGesture() || !input.displayed()) return
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
        // Pinning exists to keep the rows a mid-history reader is looking at
        // mounted while a huge resize shifts the range. While bottom-anchored
        // the anchor re-scroll wins immediately, so the pin scan — a forced
        // layout (getBoundingClientRect per rendered row) inside the resize
        // flush — buys nothing and is skipped.
        if (
          root &&
          previous !== undefined &&
          !input.shouldAnchorBottom() &&
          Math.abs(size - previous) > root.clientHeight
        ) {
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

/**
 * Per-row frame styles for a virtualized timeline row. Offscreen rows carry
 * `content-visibility: auto` so the browser skips their style/layout/paint
 * entirely while the box keeps the virtualizer's size — scroll math is
 * unchanged, and `auto` intrinsic sizing retains each row's last RENDERED
 * height so re-measures after a scroll approach stay exact. On-screen rows are
 * unaffected.
 */
export function timelineRowFrameStyle(input: {
  size: number
  minHeight: number | undefined
}): Record<string, string | undefined> {
  return {
    "min-height": input.minHeight === undefined ? undefined : `${input.minHeight}px`,
    "content-visibility": "auto",
    "contain-intrinsic-size": `auto ${input.size}px`,
  }
}
