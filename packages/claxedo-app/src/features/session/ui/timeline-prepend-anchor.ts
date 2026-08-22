export type TimelinePrependAnchor = {
  key: string
  offset: number
}

export function captureTimelinePrependAnchor(root: HTMLElement): TimelinePrependAnchor | undefined {
  const view = root.getBoundingClientRect()
  const anchor = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")]
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
    .sort((a, b) => a.rect.top - b.rect.top)[0]
  if (!anchor?.element.dataset.timelineKey) return undefined
  return {
    key: anchor.element.dataset.timelineKey,
    offset: anchor.rect.top - view.top,
  }
}

export function applyTimelinePrependAnchor(
  root: HTMLElement,
  anchor: TimelinePrependAnchor,
  resolveRowStart?: (key: string) => number | undefined,
) {
  const element = root.querySelector<HTMLElement>(timelinePrependAnchorSelector(anchor.key))
  if (!element) {
    // The anchored row can be virtualized out entirely — e.g. a reveal that
    // prepends more than a viewport's worth of rows while the scroller sits at
    // the top: the anchor lands far below the visible range and never mounts,
    // so the DOM measurement above has nothing to correct against and the
    // viewport silently stays on the prepended content. Fall back to the
    // virtualizer's own offset for the row so the compensating write still
    // happens; once the write scrolls the row back into range, the precise
    // DOM path takes over on the following frames.
    const start = resolveRowStart?.(anchor.key)
    if (start === undefined) return "missing"
    const target = Math.max(0, start - anchor.offset)
    if (Math.abs(root.scrollTop - target) <= 0.5) return "stable"
    root.scrollTop = target
    return "adjusted"
  }
  const delta = element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset
  if (Math.abs(delta) <= 0.5) return "stable"
  root.scrollTop += delta
  return "adjusted"
}

function timelinePrependAnchorSelector(key: string) {
  return `[data-timeline-key="${escapeTimelineKey(key)}"]`
}

function escapeTimelineKey(key: string) {
  return globalThis.CSS?.escape?.(key) ?? key.replace(/["\\]/g, "\\$&")
}
