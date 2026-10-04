import { createSignal, type Accessor } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { quoteBoxPosition, visibleBounds, type Box, type QuoteBoxPosition } from "./selected-quote"

export type AnchoredPosition = {
  readonly position: Accessor<QuoteBoxPosition | undefined>
  readonly anchor: Accessor<Box | undefined>
  readonly place: () => void
}

export function createAnchoredPosition(input: {
  readonly anchor: () => Box | undefined
  readonly area: () => Box | undefined
}): AnchoredPosition {
  const [position, setPosition] = createSignal<QuoteBoxPosition>()
  const [anchor, setAnchor] = createSignal<Box>()
  const place = () => {
    const next = input.anchor()
    if (!next) {
      setAnchor(undefined)
      setPosition(undefined)
      return
    }
    if (next.top === next.bottom && next.left === next.right) return
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    setAnchor({ top: next.top, bottom: next.bottom, left: next.left, right: next.right })
    setPosition(quoteBoxPosition(next, visibleBounds(input.area(), viewport), viewport))
  }
  makeEventListener(window, "scroll", place, { capture: true, passive: true })
  makeEventListener(window, "resize", place)
  return { position, anchor, place }
}
