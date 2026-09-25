import type { JSX } from "solid-js"

export type ReviewScrollPosition = {
  readonly top: number
  readonly anchorPath?: string
  readonly anchorOffset?: number
}

const MAX_SETTLE_ATTEMPTS = 8

type Restoration = {
  element: HTMLElement | undefined
  anchorTop: ((path: string) => number | undefined) | undefined
  observer: MutationObserver | undefined
  frame: number | undefined
  captureFrame: number | undefined
  restoring: boolean
}

function visible(element: HTMLElement | undefined): element is HTMLElement {
  return !!element && element.isConnected && element.clientHeight > 0
}

function rows(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>("[data-review-file]"))
}

function anchorFor(element: HTMLElement, path: string | undefined): HTMLElement | undefined {
  return path ? rows(element).find((row) => row.dataset.reviewFile === path) : undefined
}

function nearestAnchor(element: HTMLElement): HTMLElement | undefined {
  const top = element.getBoundingClientRect().top
  const distance = (row: HTMLElement) => Math.abs(row.getBoundingClientRect().top - top)
  return rows(element)
    .filter((row) => {
      const rect = row.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    .toSorted((left, right) => distance(left) - distance(right))[0]
}

function offsetOf(element: HTMLElement, anchor: HTMLElement): number {
  return anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
}

export function createReviewScrollRestoration(input: {
  readonly position: () => ReviewScrollPosition
  readonly publish: (position: ReviewScrollPosition) => void
  readonly anchorExists: (path: string) => boolean | undefined
}) {
  const state: Restoration = {
    element: undefined,
    anchorTop: undefined,
    observer: undefined,
    frame: undefined,
    captureFrame: undefined,
    restoring: false,
  }
  const cancelCapture = () => {
    if (state.captureFrame !== undefined) cancelAnimationFrame(state.captureFrame)
    state.captureFrame = undefined
  }
  const stopObserver = () => {
    state.observer?.disconnect()
    state.observer = undefined
  }
  const capture = () => {
    cancelCapture()
    const element = state.element
    if (!visible(element)) return
    if (Math.abs(element.scrollTop - input.position().top) > 0.5) return
    const anchor = nearestAnchor(element)
    if (!anchor) return
    input.publish({ top: element.scrollTop, anchorPath: anchor.dataset.reviewFile, anchorOffset: offsetOf(element, anchor) })
  }
  const waitForAnchor = (element: HTMLElement, position: ReviewScrollPosition, path: string) => {
    if (input.anchorExists(path) === false) {
      stopObserver()
      element.scrollTop = Math.max(0, Math.min(position.top, element.scrollHeight - element.clientHeight))
      state.restoring = false
      return
    }
    const documentTop = state.anchorTop?.(path)
    const landing = documentTop !== undefined ? documentTop - (position.anchorOffset ?? 0) : position.top
    if (Math.abs(element.scrollTop - landing) > 0.5) element.scrollTop = landing
    if (state.observer) return
    state.observer = new MutationObserver(() => apply(0))
    state.observer.observe(element, { childList: true, subtree: true })
  }
  const settle = (attempt: number) => {
    state.frame = requestAnimationFrame(() => {
      state.frame = undefined
      const element = state.element
      if (!visible(element)) return void (state.restoring = false)
      const position = input.position()
      const anchor = anchorFor(element, position.anchorPath)
      const error =
        anchor && position.anchorOffset !== undefined
          ? Math.abs(offsetOf(element, anchor) - position.anchorOffset)
          : Math.abs(element.scrollTop - position.top)
      if (attempt < MAX_SETTLE_ATTEMPTS && (attempt < 1 || error > 0.5)) return apply(attempt + 1)
      state.restoring = false
    })
  }
  const apply = (attempt: number) => {
    const element = state.element
    if (!visible(element)) return void (state.restoring = false)
    const position = input.position()
    const anchor = anchorFor(element, position.anchorPath)
    if (position.anchorPath && !anchor) return waitForAnchor(element, position, position.anchorPath)
    stopObserver()
    element.scrollTop =
      anchor && position.anchorOffset !== undefined
        ? element.scrollTop + offsetOf(element, anchor) - position.anchorOffset
        : position.top
    settle(attempt)
  }
  const restore = () => {
    if (!visible(state.element)) return
    if (state.frame !== undefined) cancelAnimationFrame(state.frame)
    state.frame = undefined
    state.restoring = true
    apply(0)
  }
  const remember: JSX.EventHandler<HTMLDivElement, Event> = (event) => {
    if (state.restoring || !visible(state.element)) return
    const target = event.currentTarget
    input.publish({ ...input.position(), top: target.scrollTop })
    cancelCapture()
    state.captureFrame = requestAnimationFrame(() => {
      state.captureFrame = undefined
      if (state.element === target) capture()
    })
  }
  const dispose = () => {
    if (state.frame !== undefined) cancelAnimationFrame(state.frame)
    if (state.captureFrame !== undefined) capture()
    stopObserver()
    state.element = undefined
    state.anchorTop = undefined
    state.frame = undefined
  }
  return {
    bind: (element: HTMLElement) => {
      state.element = element
      restore()
    },
    bindAnchorTop: (resolve: ((path: string) => number | undefined) | undefined) => {
      state.anchorTop = resolve
    },
    remember,
    restore,
    dispose,
  }
}
