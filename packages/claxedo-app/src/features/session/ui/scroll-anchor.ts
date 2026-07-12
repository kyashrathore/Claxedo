// Pure scroll geometry extracted from `session.tsx`. The DOM plumbing
// (reading rects, calling `requestAnimationFrame`) stays in the component; the
// arithmetic that decides scroll state and which message the viewport is
// anchored on is here, where it can be tested without a browser.

export type ScrollState = {
  overflow: boolean
  bottom: boolean
  jump: boolean
}

/**
 * Derive the scroller's overflow/at-bottom/should-show-jump state from its
 * measured metrics.
 *
 * - `overflow`: content is taller than the viewport (with a 1px tolerance).
 * - `bottom`: pinned to the end (or not overflowing), within 2px.
 * - `jump`: overflowing and scrolled up by more than max(400px, one viewport),
 *   i.e. far enough that a "jump to latest" affordance is warranted.
 */
export function computeScrollState(metrics: {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}): ScrollState {
  const max = metrics.scrollHeight - metrics.clientHeight
  const overflow = max > 1
  const bottom = !overflow || metrics.scrollTop >= max - 2
  const jump = overflow && max - metrics.scrollTop > Math.max(400, metrics.clientHeight)
  return { overflow, bottom, jump }
}

export type MessageRect = {
  id: string
  top: number
  bottom: number
}

/**
 * Choose the message id the viewport is "on", given each message's rect, the
 * viewport box, and the anchor `line` (a y-coordinate, typically 100px below
 * the viewport top).
 *
 * Priority:
 * 1. A visible message whose rect straddles the anchor line.
 * 2. Otherwise the visible message whose top is nearest the line (ties broken
 *    by the higher one).
 * 3. Otherwise the last message that begins at or above the line, then the
 *    first message, then `fallback`.
 *
 * "Visible" means the rect overlaps the viewport box vertically.
 */
export function pickAnchorMessageId(input: {
  items: readonly MessageRect[]
  box: { top: number; bottom: number }
  line: number
  fallback?: string
}): string | undefined {
  const { items, box, line } = input
  const shown = items.filter((item) => item.bottom > box.top && item.top < box.bottom)

  const hit = shown.find((item) => item.top <= line && item.bottom >= line)
  if (hit) return hit.id

  const near = [...shown].sort((a, b) => {
    const da = Math.abs(a.top - line)
    const db = Math.abs(b.top - line)
    if (da !== db) return da - db
    return a.top - b.top
  })[0]
  if (near) return near.id

  return items.filter((item) => item.top <= line).at(-1)?.id ?? items[0]?.id ?? input.fallback
}
