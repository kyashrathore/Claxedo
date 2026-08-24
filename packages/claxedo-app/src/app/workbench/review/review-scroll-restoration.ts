import type { JSX } from "solid-js"

export type ReviewScrollPosition = {
  top: number
  anchorPath?: string
  anchorOffset?: number
}

export function createReviewScrollRestoration(input: {
  visible: () => boolean
  canRecord: () => boolean
  initial?: ReviewScrollPosition
  onChange?: (position: ReviewScrollPosition) => void
}) {
  let frame: number | undefined
  let captureTimer: ReturnType<typeof setTimeout> | undefined
  let observer: MutationObserver | undefined
  let element: HTMLDivElement | undefined
  let restoring = false
  let position: ReviewScrollPosition = input.initial ?? { top: 0 }

  const anchorFor = (path: string | undefined) => path && element
    ? Array.from(element.querySelectorAll<HTMLElement>("[data-review-file]"))
      .find((candidate) => candidate.dataset.reviewFile === path)
    : undefined
  const nearestAnchor = () => {
    if (!element) return
    const viewportTop = element.getBoundingClientRect().top
    return Array.from(element.querySelectorAll<HTMLElement>("[data-review-file]"))
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      .toSorted((left, right) =>
        Math.abs(left.getBoundingClientRect().top - viewportTop) -
        Math.abs(right.getBoundingClientRect().top - viewportTop)
      )[0]
  }
  const publish = (next: ReviewScrollPosition) => {
    position = next
    input.onChange?.(next)
  }
  const capture = () => {
    if (!element) return
    const anchor = nearestAnchor()
    publish({
      top: element.scrollTop,
      anchorPath: anchor?.dataset.reviewFile,
      anchorOffset: anchor
        ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
        : undefined,
    })
  }
  const stopObserver = () => {
    observer?.disconnect()
    observer = undefined
  }
  const apply = (attempt = 0) => {
    if (!element || !input.visible()) {
      restoring = false
      return
    }
    const anchor = anchorFor(position.anchorPath)
    if (position.anchorPath && !anchor) {
      if (!observer && typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(() => apply())
        observer.observe(element, { childList: true, subtree: true })
      }
      return
    }
    stopObserver()
    element.scrollTop = anchor && position.anchorOffset !== undefined
      ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.anchorOffset
      : position.top
    if (typeof requestAnimationFrame !== "function") {
      restoring = false
      return
    }
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!element || !input.visible()) {
        restoring = false
        return
      }
      const currentAnchor = anchorFor(position.anchorPath)
      const error = currentAnchor && position.anchorOffset !== undefined
        ? Math.abs(currentAnchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.anchorOffset)
        : Math.abs(element.scrollTop - position.top)
      if (attempt < 8 && (attempt < 1 || error > 0.5)) {
        apply(attempt + 1)
        return
      }
      restoring = false
    })
  }
  const restore = () => {
    if (!element || !input.visible()) return
    if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
    frame = undefined
    restoring = true
    apply()
  }
  const bind = (next: HTMLDivElement) => {
    element = next
    restore()
  }
  const remember: JSX.EventHandler<HTMLDivElement, Event> = (event) => {
    if (!input.canRecord() || restoring) return
    const target = event.currentTarget
    publish({ ...position, top: target.scrollTop })
    if (captureTimer) clearTimeout(captureTimer)
    captureTimer = setTimeout(() => {
      captureTimer = undefined
      if (element !== target || !input.canRecord()) return
      capture()
    }, 80)
  }
  const dispose = () => {
    if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
    if (captureTimer) clearTimeout(captureTimer)
    stopObserver()
  }

  return { bind, capture, dispose, remember, restore }
}
