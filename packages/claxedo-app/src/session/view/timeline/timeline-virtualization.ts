import { batch } from "solid-js"
import type { VirtualItem, Virtualizer } from "@tanstack/solid-virtual"
import { TRANSCRIPT_NUMBERS, type ResolvedTranscriptTypography } from "@/ui/utils"

export function estimateLongMarkdownHeight(text: string) {
  let lineCount = 1
  for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", newline + 1)) lineCount += 1
  if (lineCount < 20) return undefined

  return Math.min(60_000, lineCount * 26)
}

export function scheduleConnectedMeasure<T extends HTMLElement>(element: T, measure: (element: T) => void) {
  return requestAnimationFrame(() => {
    if (element.isConnected) measure(element)
  })
}

export function measureUnmeasuredRows(virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>) {
  const unmeasured = [...virtualizer.elementsCache].flatMap(([key, element]) => (element.isConnected && !virtualizer.itemSizeCache.has(key) ? [element] : []))
  if (unmeasured.length) batch(() => unmeasured.forEach((element) => virtualizer.measureElement(element)))
}

const timelineInitialEstimatedItemSize = 180

type TimelineResizeAnchorInput = {
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
  root: () => HTMLDivElement | undefined
  displayed: () => boolean
  shouldAnchorBottom: () => boolean
  hasScrollGesture: () => boolean
  holdsInViewInserts: () => boolean
  onInViewInsert?: () => void
  followsInsertBeside?: (displacedKey: string) => boolean
}

export type FixedRowHeights = { readonly turnGap: number; readonly turnFold: number }

const turnFoldRuleHeight = 1

export function fixedRowHeights(typography: Pick<ResolvedTranscriptTypography, "turnGap" | "toolRowHeight">): FixedRowHeights {
  return {
    turnGap: typography.turnGap ?? TRANSCRIPT_NUMBERS.turnGap.shipped,
    turnFold: (typography.toolRowHeight ?? TRANSCRIPT_NUMBERS.toolRowHeight.shipped) + turnFoldRuleHeight,
  }
}

export function estimateTimelineRowSize(input: {
  index: number
  rows: readonly { _tag: string; group?: { type: string; ref?: { messageId: string; partId: string } } }[]
  parts: (messageId: string) => readonly { id: string; type: string; text?: string }[]
  fixed: FixedRowHeights
}) {
  const row = input.rows[input.index]
  if (row?._tag === "TurnGap") return input.fixed.turnGap
  if (row?._tag === "TurnFold") return input.fixed.turnFold
  if (row?._tag !== "AssistantPart") return timelineInitialEstimatedItemSize
  if (input.index < input.rows.length - 50) return timelineInitialEstimatedItemSize
  const group = row.group
  if (!group || group.type !== "part" || !group.ref) return timelineInitialEstimatedItemSize
  const part = input.parts(group.ref.messageId).find((item) => item.id === group.ref!.partId)
  if (part?.type !== "text") return timelineInitialEstimatedItemSize
  return estimateLongMarkdownHeight(part.text ?? "") ?? timelineInitialEstimatedItemSize
}

export function createTimelineResizeAnchor() {
  let pinnedIndexes: number[] = []
  let pinFrame: number | undefined
  let anchorScheduled = false
  let disposed = false
  let insertHoldUntil = 0
  let previousKeys: string[] | undefined
  let installed: TimelineResizeAnchorInput | undefined

  const held = () => performance.now() < insertHoldUntil

  return {
    pinnedIndexes: () => pinnedIndexes,
    held,
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
      if (!input || !previous || keys.length <= previous.length || !input.holdsInViewInserts()) return
      const root = input.root()
      if (!root) return
      let index = 0
      while (index < previous.length && previous[index] === keys[index]) index += 1
      if (index === 0 || index >= keys.length) return
      const anchorKey = index < previous.length ? previous[index] : previous[index - 1]
      const displaced = input.virtualizer.measurementsCache.find((item) => item.key === anchorKey)
      if (displaced && index >= previous.length - 2 && displaced.start < root.scrollTop + root.clientHeight - 1) {
        insertHoldUntil = performance.now() + 250
        input.onInViewInsert?.()
        const anchored = input.shouldAnchorBottom() || (input.followsInsertBeside?.(anchorKey) ?? false)
        setTimeout(() => {
          const current = installed
          const el = current?.root()
          if (disposed || !current || !el || !current.displayed() || !anchored || current.hasScrollGesture()) return
          current.virtualizer.getTotalSize()
          const tail = current.virtualizer.measurementsCache.at(-1)
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
        if (disposed || size === 0) return
        const item = input.virtualizer.measurementsCache[index]
        const previous = item ? (input.virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
        const root = input.root()
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

export function timelineRowFrameStyle(input: {
  minHeight: number | undefined
}): Record<string, string | undefined> {
  return {
    "min-height": input.minHeight === undefined ? undefined : `${input.minHeight}px`,
  }
}
