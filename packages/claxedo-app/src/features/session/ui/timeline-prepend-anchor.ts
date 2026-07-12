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

export function applyTimelinePrependAnchor(root: HTMLElement, anchor: TimelinePrependAnchor) {
  const element = root.querySelector<HTMLElement>(timelinePrependAnchorSelector(anchor.key))
  if (!element) return "missing"
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
