import { createSignal } from "solid-js"

export const normalizeWheelDelta = (input: { deltaY: number; deltaMode: number; rootHeight: number }) => {
  if (input.deltaMode === 1) return input.deltaY * 40
  if (input.deltaMode === 2) return input.deltaY * input.rootHeight
  return input.deltaY
}

export const shouldMarkBoundaryGesture = (input: {
  delta: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}) => {
  const max = input.scrollHeight - input.clientHeight
  if (max <= 1) return true
  if (!input.delta) return false

  if (input.delta < 0) return input.scrollTop + input.delta <= 0

  const remaining = max - input.scrollTop
  return input.delta > remaining
}

// Wheel/drag gestures inside a NESTED scroller (a capped tool output) must not
// count: the reader scrolls that box, not the transcript — treating it as a
// transcript gesture would leave follow-bottom mode on every output scroll.
export function createScrollGestureWindow(input: {
  scroller: () => HTMLElement | undefined
  windowMs?: number
}) {
  const [stamp, setStamp] = createSignal(0)
  const windowMs = input.windowMs ?? 250
  const mark = (target?: EventTarget | null) => {
    const root = input.scroller()
    if (!root) return
    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return
    setStamp(Date.now())
  }
  const active = () => Date.now() - stamp() < windowMs
  return { mark, active }
}
