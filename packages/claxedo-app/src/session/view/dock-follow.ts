import { createSignal, onCleanup } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import type { TimelineScroll } from "./timeline-scroll"

function createDockResizeHandler(input: {
  scroller: () => HTMLDivElement | undefined
  userScrolled: () => boolean
  scrollToEnd: () => void
  scheduleScrollState: (scroller: HTMLDivElement) => void
}) {
  let active = true
  let frame: number | undefined
  let height = 0

  return {
    resize(value: number) {
      const next = Math.ceil(value)
      if (!active || next === height) return

      const scroller = input.scroller()
      const delta = next - height
      const stick = scroller
        ? !input.userScrolled() ||
          scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 10 + Math.max(0, delta)
        : false
      height = next

      if (stick && frame === undefined) {
        frame = requestAnimationFrame(() => {
          frame = undefined
          if (active) input.scrollToEnd()
        })
      }
      if (scroller) input.scheduleScrollState(scroller)
    },
    dispose: () => {
      active = false
      if (frame === undefined) return
      cancelAnimationFrame(frame)
      frame = undefined
    },
  }
}

export function createDockFollow(scroll: TimelineScroll) {
  const [dock, setDock] = createSignal<HTMLElement>()
  const handler = createDockResizeHandler({
    scroller: scroll.scroller,
    userScrolled: scroll.userScrolled,
    scrollToEnd: scroll.scrollToEnd,
    scheduleScrollState: scroll.schedule,
  })
  createResizeObserver(dock, ({ height }) => handler.resize(height))
  onCleanup(handler.dispose)
  return setDock
}
