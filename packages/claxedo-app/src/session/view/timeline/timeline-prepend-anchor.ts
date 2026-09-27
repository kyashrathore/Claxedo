import { createDisplayedFrameLoop } from "./timeline-displayed-frames"

export type TimelinePrependAnchor = {
  key: string
  offset: number
}

export function captureTimelinePrependAnchor(root: HTMLElement): TimelinePrependAnchor | undefined {
  const view = root.getBoundingClientRect()
  const anchor = [...root.querySelectorAll<HTMLElement>('[data-timeline-key]:not([data-timeline-anchor="none"])')]
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

export function createTimelinePrependAnchor(input: {
  root: () => HTMLElement | undefined
  displayed: () => boolean
  following: () => boolean
  resolveRowStart: (key: string) => number | undefined
}) {
  const frames = createDisplayedFrameLoop({ displayed: input.displayed })
  let anchor: TimelinePrependAnchor | undefined
  let loading = false
  const clear = () => { loading = false; anchor = undefined; frames.stop() }
  const update = () => {
    const root = input.root()
    if (root && !input.following()) anchor = captureTimelinePrependAnchor(root) ?? anchor
  }
  const apply = (next = anchor) => {
    anchor = next
    const root = input.root()
    if (!root || !next) return
    let count = 0, stable = 0
    frames.start(() => {
      stable = applyTimelinePrependAnchor(root, next, input.resolveRowStart) === "adjusted" ? 0 : stable + 1
      if (++count >= 180 || stable >= 30) {
        anchor = undefined
        return false
      }
      return true
    })
  }
  return {
    loading: () => loading,
    running: () => frames.running,
    update, apply,
    resume: frames.resume,
    capture: () => { loading = true; update() },
    restore: () => { loading = false; apply() },
    clear,
    settle: () => {
      const root = input.root()
      if (frames.running && root && anchor) applyTimelinePrependAnchor(root, anchor, input.resolveRowStart)
      clear()
    },
  }
}
