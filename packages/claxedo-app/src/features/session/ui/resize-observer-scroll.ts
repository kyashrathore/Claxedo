export function createPromptDockResizeHandler(input: {
  scroller: () => HTMLDivElement | undefined
  userScrolled: () => boolean
  scrollToEnd: () => void
  scheduleScrollState: (scroller: HTMLDivElement) => void
  scheduleHistoryFill: () => void
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (frame: number) => void
}) {
  const requestFrame = input.requestFrame ?? requestAnimationFrame
  const cancelFrame = input.cancelFrame ?? cancelAnimationFrame
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
        frame = requestFrame(() => {
          frame = undefined
          if (active) input.scrollToEnd()
        })
      }
      if (scroller) input.scheduleScrollState(scroller)
      input.scheduleHistoryFill()
    },
    dispose() {
      active = false
      if (frame === undefined) return
      cancelFrame(frame)
      frame = undefined
    },
  }
}
