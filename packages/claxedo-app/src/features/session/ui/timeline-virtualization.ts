import type { Virtualizer } from "@tanstack/solid-virtual"

export function estimateLongMarkdownHeight(text: string) {
  let lineCount = 1
  for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", newline + 1)) lineCount += 1
  // Short responses stay on the virtualizer default. Avoid any further work
  // for the overwhelmingly common small response while the virtualizer
  // estimates the complete history.
  if (lineCount < 20) return

  // Calibrated against rendered transcripts (live measurement, 2026-09-01):
  // long markdown renders at ~28px per SOURCE line at p50 (headings/lists run
  // ~35, dense code ~20). The estimate must track that scale: a giant single
  // part (1,849 lines) renders at 52,961px, and a low cap makes the anchored
  // viewport chase a 9x size correction when the row first measures — the
  // visible symptom is a blank viewport while the bottom anchor converges
  // after a session switch. Overestimating is the cheaper error: the anchor
  // lands immediately and the scroll thumb is briefly generous, so the cap
  // exists only to bound truly adversarial payloads.
  return Math.min(60_000, lineCount * 26)
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
        if (root && previous !== undefined && !input.shouldAnchorBottom() && Math.abs(size - previous) > root.clientHeight) {
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
 * Per-row frame styles for a virtualized timeline row. Rows render fully at
 * mount — no `content-visibility: auto`. Skippable rendering poisons the
 * virtualizer: a cold row mounted in the overscan band is in skip state when
 * `measureElement` runs, so it measures at the `contain-intrinsic-size`
 * estimate instead of its content (a 24px turn gap measured — and painted —
 * as the 180px placeholder), and a fast flick scrolls skipped rows into the
 * viewport before the browser renders them, showing estimate-sized blank
 * boxes. The overscan band is small (≤6 rows), so eager rendering costs a
 * handful of rows and buys exact measurements plus pre-painted rows ahead of
 * the scroll direction.
 */
export function timelineRowFrameStyle(input: {
  minHeight: number | undefined
}): Record<string, string | undefined> {
  return {
    "min-height": input.minHeight === undefined ? undefined : `${input.minHeight}px`,
  }
}
