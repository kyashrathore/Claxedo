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
 * Per-row frame styles for a virtualized timeline row. Rows the virtualizer has
 * MEASURED carry `content-visibility: auto` so the browser skips their
 * style/layout/paint entirely while the box keeps the virtualizer's size --
 * scroll math is unchanged, and `auto` intrinsic sizing retains each row's last
 * RENDERED height so re-measures after a scroll approach stay exact.
 *
 * `contain` is the whole condition, because `content-visibility` is a promise
 * that this row's size is ALREADY KNOWN. Setting it on a row nobody has
 * measured is self-defeating, and it was costing every cold first fold an extra
 * layout and paint: the browser skips the subtree, so `measureElement` reads
 * the ESTIMATE straight back and publishes nothing; the row keeps its estimated
 * height; and because the wrapper clips to that height the fold paints CLIPPED.
 * Only once the browser decides the row is relevant and lays it out does the
 * real measurement land -- and the whole fold paints a second time. On a
 * hundred-kilobyte Markdown row that second paint is a second LCP candidate.
 *
 * A row seeded from `initialMeasurementsCache` (any warm switch) is measured
 * from its first frame, so the skip still applies exactly where it pays. So is
 * every row OUTSIDE the visible window: an overscan row nobody can see costs
 * nothing by staying skipped, and containing it is what keeps a cold fold from
 * laying out its whole overscan in the one frame that reveals it.
 */
export function timelineRowFrameStyle(input: {
  size: number
  minHeight: number | undefined
  /**
   * Whether this row may keep its layout skipped: the virtualizer already has a
   * real measurement for it, or it is outside the visible window.
   */
  contain: boolean
}): Record<string, string | undefined> {
  return {
    "min-height": input.minHeight === undefined ? undefined : `${input.minHeight}px`,
    "content-visibility": input.contain ? "auto" : undefined,
    "contain-intrinsic-size": input.contain ? `auto ${input.size}px` : undefined,
  }
}

/** Whether `index` sits in the virtualizer's CURRENT visible window, overscan excluded. */
function timelineRowInVisibleWindow(
  virtualizer: Pick<Virtualizer<HTMLDivElement, HTMLDivElement>, "range">,
  index: number,
): boolean {
  const range = virtualizer.range
  if (!range) return false
  return index >= range.startIndex && index <= range.endIndex
}

/**
 * One row's frame style, with containment decided from the virtualizer rather
 * than by the caller: a row keeps its layout skipped when the virtualizer holds
 * a real measurement for it, or when it is outside the visible window.
 *
 * Both reads are non-reactive on purpose. This runs from the row's style, which
 * re-runs whenever that row's virtual item changes -- and the measurement
 * landing is exactly what changes `item.size`, so a row picks the skip up on
 * the same update that makes it honest. The only direction either read can be
 * stale in is a row that just scrolled into view still marked contained, which
 * corrects itself on that row's next update.
 */
export function timelineRowStyle(
  virtualizer: Pick<Virtualizer<HTMLDivElement, HTMLDivElement>, "range" | "itemSizeCache">,
  rowKey: string,
  item: { index: number; size: number },
  minHeight: number | undefined,
): Record<string, string | undefined> {
  return timelineRowFrameStyle({
    size: item.size,
    minHeight,
    contain: virtualizer.itemSizeCache.has(rowKey) || !timelineRowInVisibleWindow(virtualizer, item.index),
  })
}
