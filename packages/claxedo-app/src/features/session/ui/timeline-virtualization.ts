import type { VirtualItem, Virtualizer } from "@tanstack/solid-virtual"

export function estimateLongMarkdownHeight(text: string) {
  let lineCount = 1
  for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", newline + 1)) lineCount += 1
  // Short responses stay on the virtualizer default. Avoid any further work
  // for the overwhelmingly common small response while the virtualizer
  // estimates the complete history.
  if (lineCount < 20) return undefined

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

const timelineInitialEstimatedItemSize = 180

type TimelineResizeAnchorInput = {
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
  onInViewInsert?: () => void
}

export function estimateTimelineRowSize(input: {
  index: number
  rows: readonly { _tag: string; group?: { type: string; ref?: { messageID: string; partID: string } } }[]
  parts: (messageID: string) => readonly { id: string; type: string; text?: string }[]
}) {
  const row = input.rows[input.index]
  if (row?._tag !== "AssistantPart") return timelineInitialEstimatedItemSize
  // Initial bottom-anchored layout only needs precise estimates around the
  // first visible fold. Scanning every older Markdown body blocks the
  // viewport callback even though those rows remain virtual and will be
  // measured when the user approaches them.
  if (input.index < input.rows.length - 50) return timelineInitialEstimatedItemSize
  const group = row.group
  if (!group || group.type !== "part" || !group.ref) return timelineInitialEstimatedItemSize
  const part = input.parts(group.ref.messageID).find((item) => item.id === group.ref!.partID)
  if (part?.type !== "text") return timelineInitialEstimatedItemSize
  return estimateLongMarkdownHeight(part.text ?? "") ?? timelineInitialEstimatedItemSize
}

export function createTimelineResizeAnchor() {
  let pinnedIndexes: number[] = []
  let pinFrame: number | undefined
  let anchorScheduled = false
  let disposed = false
  // A row inserted inside the viewport (a reply's first part landing above the
  // busy tail) is already revealed: pinning the bottom would shift every
  // visible row by the insert's height. The hold covers the insert's own
  // measure pass plus the deferred anchor microtask.
  let insertHoldUntil = 0
  let previousKeys: string[] | undefined
  let installed: TimelineResizeAnchorInput | undefined

  const held = () => performance.now() < insertHoldUntil

  return {
    pinnedIndexes: () => pinnedIndexes,
    held,
    /**
     * Scroll compensation for a resized row, installed onto the virtualizer's
     * `shouldAdjustScrollPositionOnItemSizeChange` extension point. Stands down
     * entirely while the timeline is bottom-anchored — `wasAtEnd` already moves
     * the viewport by the total-size delta, so a second compensation doubles it.
     */
    shouldAdjustResize(item: VirtualItem, instance: Virtualizer<HTMLDivElement, HTMLDivElement>) {
      const input = installed
      if (!input || input.shouldAnchorBottom()) return false
      const first = instance.range?.startIndex
      return first !== undefined && item.index < first
    },
    noteRowKeys(keys: string[]) {
      const previous = previousKeys
      previousKeys = keys
      const input = installed
      if (!input || !previous || keys.length <= previous.length) return
      const root = input.root()
      if (!root) return
      let index = 0
      while (index < previous.length && previous[index] === keys[index]) index += 1
      if (index >= keys.length) return
      // The insert lands where the row it displaced used to start — look the
      // displaced row up by key, since index-keyed measurements are mid-flush
      // here.
      const displaced = input.virtualizer.measurementsCache.find((item) => item.key === previous[index])
      // Only a near-tail insert that displaces a visible row can push the
      // anchored tail — a pure append reveals by following, and history
      // prepends land far above with their own above-fold compensation.
      if (displaced && index >= previous.length - 2 && displaced.start < root.scrollTop + root.clientHeight - 1) {
        insertHoldUntil = performance.now() + 250
        input.onInViewInsert?.()
        // The hold only covers the insert's own measure pass. When it lifts,
        // follow once if the insert pushed the tail row below the fold — the
        // reader is anchored to the tail, not to a fixed document offset.
        setTimeout(() => {
          const current = installed
          const el = current?.root()
          if (disposed || !current || !el || !current.displayed() || !current.shouldAnchorBottom() || current.hasScrollGesture()) return
          // measurementsCache is memoized — materialize it before reading the
          // tail, or the pre-insert positions make the overflow check miss.
          current.virtualizer.getTotalSize()
          const tail = current.virtualizer.measurementsCache.at(-1)
          // Follow only when the insert pushed the tail row below the fold; a
          // tail still inside the viewport stayed visible and nothing moved.
          if (tail && tail.end > el.scrollTop + el.clientHeight - 1) current.virtualizer.scrollToEnd()
        }, 260)
      }
    },
    install(input: TimelineResizeAnchorInput) {
      installed = input
      input.virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
        this.shouldAdjustResize(item, instance)

      const resizeItem = input.virtualizer.resizeItem.bind(input.virtualizer)
      const anchorBottom = () => {
        if (disposed || anchorScheduled || input.hasScrollGesture() || !input.displayed() || held()) return
        anchorScheduled = true
        queueMicrotask(() => {
          anchorScheduled = false
          if (disposed || !input.displayed() || !input.shouldAnchorBottom() || input.hasScrollGesture() || held()) return
          input.virtualizer.scrollToEnd()
        })
      }

      input.virtualizer.resizeItem = (index: number, size: number) => {
        // A rendered row is never 0px. A zero measurement means the element was
        // measured while its surface was display-locked (the workbench keeps
        // sessions mounted under `content-visibility: hidden`) or detached, and
        // caching it collapses the virtualizer's total size to `paddingEnd`.
        // The scroller then has nothing to scroll, so the bottom anchor cannot
        // land and the last turn paints at the TOP of the viewport with a gap
        // above the composer — until real measurements arrive and shove
        // everything down. Dropping the zero keeps this row on its estimate,
        // which is close enough for the anchor to be right on the first frame.
        if (disposed || size === 0) return
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
      disposed = true
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
