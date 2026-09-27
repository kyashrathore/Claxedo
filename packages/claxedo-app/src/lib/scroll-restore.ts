import { createEffect, untrack, type Accessor } from "solid-js"

export function restoreScrollTop(input: {
  readonly element: Accessor<HTMLElement | undefined>
  readonly contentReady: Accessor<boolean>
  readonly top: () => number
}): void {
  createEffect((restored: boolean) => {
    if (restored) return true
    const element = input.element()
    if (!element || !input.contentReady()) return false
    const top = untrack(input.top)
    if (top !== 0) element.scrollTop = top
    return true
  }, false)
}
