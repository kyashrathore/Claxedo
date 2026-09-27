import type { PaintedFrames } from "./page-globals"

export function installPaintedFrames() {
  if (window.__claxedoPaintedFrames) return
  let inputAt = Number.NEGATIVE_INFINITY
  const input = (event: Event) => {
    if (event.isTrusted) inputAt = performance.now()
  }
  for (const type of ["pointerdown", "pointerup", "click", "keydown", "keyup"]) window.addEventListener(type, input, { capture: true })
  const paintedFrames: PaintedFrames = (frame) => {
    let stopped = false
    const started: number[] = []
    const channel = new MessageChannel()
    const stop = () => {
      stopped = true
      channel.port1.close()
    }
    channel.port1.onmessage = () => {
      const paintedAt = performance.now()
      const startedAt = started.shift()
      if (stopped || startedAt === undefined) return
      const done = inputAt > startedAt ? frame.overtaken?.(startedAt, paintedAt) : frame.painted(frame.sample(startedAt), paintedAt)
      if (done === true) stop()
    }
    const callback = () => {
      if (stopped) return
      started.push(performance.now())
      requestAnimationFrame(callback)
      channel.port2.postMessage(undefined)
    }
    requestAnimationFrame(callback)
    return stop
  }
  window.__claxedoPaintedFrames = paintedFrames
}
