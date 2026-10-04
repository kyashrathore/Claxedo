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

function reviewFileRows(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>("[data-review-file]"))
}

function anchorFor(element: HTMLElement, path: string | undefined): HTMLElement | undefined {
  return path ? reviewFileRows(element).find((row) => row.dataset.reviewFile === path) : undefined
}

function nearestAnchor(element: HTMLElement): HTMLElement | undefined {
  const top = element.getBoundingClientRect().top
  const distance = (row: HTMLElement) => Math.abs(row.getBoundingClientRect().top - top)
  return reviewFileRows(element)
    .filter((row) => {
      const rect = row.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    .toSorted((left, right) => distance(left) - distance(right))[0]
}

function offsetOf(element: HTMLElement, anchor: HTMLElement): number {
  return anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
}

type RestorationInput = {
  readonly position: () => ReviewScrollPosition
  readonly publish: (position: ReviewScrollPosition) => void
  readonly anchorExists: (path: string) => boolean | undefined
}

function cancelCapture(state: Restoration): void {
  if (state.captureFrame !== undefined) cancelAnimationFrame(state.captureFrame)
  state.captureFrame = undefined
}

function stopObserver(state: Restoration): void {
  state.observer?.disconnect()
  state.observer = undefined
}

function capture(state: Restoration, input: RestorationInput): void {
  cancelCapture(state)
  const element = state.element
  if (!visible(element)) return
  if (Math.abs(element.scrollTop - input.position().top) > 0.5) return
  const anchor = nearestAnchor(element)
  if (!anchor) return
  input.publish({ top: element.scrollTop, anchorPath: anchor.dataset.reviewFile, anchorOffset: offsetOf(element, anchor) })
}

function waitForAnchor(
  state: Restoration,
  input: RestorationInput,
  target: { readonly element: HTMLElement; readonly position: ReviewScrollPosition; readonly path: string },
  apply: (attempt: number) => void,
): void {
  const { element, position, path } = target
  if (input.anchorExists(path) === false) {
    stopObserver(state)
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

function createApplier(state: Restoration, input: RestorationInput) {
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
  const apply = (attempt: number): void => {
    const element = state.element
    if (!visible(element)) return void (state.restoring = false)
    const position = input.position()
    const anchor = anchorFor(element, position.anchorPath)
    if (position.anchorPath && !anchor) return waitForAnchor(state, input, { element, position, path: position.anchorPath }, apply)
    stopObserver(state)
    element.scrollTop =
      anchor && position.anchorOffset !== undefined
        ? element.scrollTop + offsetOf(element, anchor) - position.anchorOffset
        : position.top
    settle(attempt)
  }
  return apply
}

function createRemember(state: Restoration, input: RestorationInput): JSX.EventHandler<HTMLDivElement, Event> {
  return (event) => {
    if (state.restoring || !visible(state.element)) return
    const target = event.currentTarget
    input.publish({ ...input.position(), top: target.scrollTop })
    cancelCapture(state)
    state.captureFrame = requestAnimationFrame(() => {
      state.captureFrame = undefined
      if (state.element === target) capture(state, input)
    })
  }
}

export function createReviewScrollRestoration(input: RestorationInput) {
  const state: Restoration = {
    element: undefined,
    anchorTop: undefined,
    observer: undefined,
    frame: undefined,
    captureFrame: undefined,
    restoring: false,
  }
  const apply = createApplier(state, input)
  const restore = () => {
    if (!visible(state.element)) return
    if (state.frame !== undefined) cancelAnimationFrame(state.frame)
    state.frame = undefined
    state.restoring = true
    apply(0)
  }
  return {
    bind: (element: HTMLElement) => {
      state.element = element
      restore()
    },
    bindAnchorTop: (resolve: ((path: string) => number | undefined) | undefined) => {
      state.anchorTop = resolve
    },
    remember: createRemember(state, input),
    restore,
    dispose: () => {
      if (state.frame !== undefined) cancelAnimationFrame(state.frame)
      if (state.captureFrame !== undefined) capture(state, input)
      stopObserver(state)
      state.element = undefined
      state.anchorTop = undefined
      state.frame = undefined
    },
  }
}
