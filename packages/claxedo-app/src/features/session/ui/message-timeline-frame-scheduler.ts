export type TimelineFrameScheduler = {
  request: (callback: FrameRequestCallback) => number
  cancel: (frame: number | undefined) => void
  cancelAll: () => void
  pending: () => number
}

/** Owns every timeline RAF so an unmounted/superseded session cannot commit late. */
export function createTimelineFrameScheduler(
  input: {
    request?: (callback: FrameRequestCallback) => number
    cancel?: (frame: number) => void
  } = {},
): TimelineFrameScheduler {
  const requestFrame = input.request ?? requestAnimationFrame
  const cancelFrame = input.cancel ?? cancelAnimationFrame
  const frames = new Set<number>()

  return {
    request(callback) {
      let frame = 0
      frame = requestFrame((time) => {
        frames.delete(frame)
        callback(time)
      })
      frames.add(frame)
      return frame
    },
    cancel(frame) {
      if (frame === undefined || !frames.delete(frame)) return
      cancelFrame(frame)
    },
    cancelAll() {
      for (const frame of frames) cancelFrame(frame)
      frames.clear()
    },
    pending: () => frames.size,
  }
}
