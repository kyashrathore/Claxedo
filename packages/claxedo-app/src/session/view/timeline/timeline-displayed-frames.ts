type FrameToken = number

export function createDisplayedFrameLoop(input: {
  displayed: () => boolean
  scheduleFrame?: (callback: () => void) => FrameToken
  cancelFrame?: (token: FrameToken) => void
}) {
  const scheduleFrame = input.scheduleFrame ?? requestAnimationFrame
  const cancelFrame = input.cancelFrame ?? cancelAnimationFrame
  let frame: FrameToken | undefined
  let step: (() => boolean) | undefined

  const arm = () => {
    if (frame !== undefined || step === undefined || !input.displayed()) return
    frame = scheduleFrame(() => {
      frame = undefined
      if (step === undefined) return
      if (!input.displayed()) return
      if (!step()) {
        step = undefined
        return
      }
      arm()
    })
  }

  return {
    start: (next: () => boolean) => {
      if (frame !== undefined) {
        cancelFrame(frame)
        frame = undefined
      }
      step = next
      arm()
    },
    resume: () => {
      arm()
    },
    stop: () => {
      step = undefined
      if (frame === undefined) return
      cancelFrame(frame)
      frame = undefined
    },
    get running() {
      return step !== undefined
    },
    get scheduled() {
      return frame !== undefined
    },
  }
}
