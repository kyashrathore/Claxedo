type PaintedFrame<T> = {
  sample: (startedAt: number) => T
  painted: (value: T, paintedAt: number) => boolean | void
}

type PaintedFrames = <T>(frame: PaintedFrame<T>) => () => void

declare global {
  interface Window {
    __claxedoPaintedFrames?: PaintedFrames
  }
}

export function installPaintedFrames() {
  if (window.__claxedoPaintedFrames) return
  const sentinel = document.createElement("div")
  sentinel.style.cssText = "width:1px;height:1px"
  let sentinelRoot = sentinel
  for (let depth = 1; depth < 256; depth += 1) {
    const parent = document.createElement("div")
    parent.append(sentinelRoot)
    sentinelRoot = parent
  }
  sentinelRoot.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none;contain:strict"
  const paintedFrames: PaintedFrames = (frame) => {
    let stopped = false
    const samples: { readonly value: ReturnType<typeof frame.sample> }[] = []
    const channel = new MessageChannel()
    const stop = () => {
      stopped = true
      channel.port1.close()
    }
    channel.port1.onmessage = () => {
      const paintedAt = performance.now()
      const sampled = samples.shift()
      if (stopped || !sampled) return
      if (frame.painted(sampled.value, paintedAt) === true) stop()
    }
    const callback = () => {
      if (stopped) return
      const startedAt = performance.now()
      requestAnimationFrame(callback)
      if (!sentinelRoot.isConnected) document.documentElement.append(sentinelRoot)
      const observer = new ResizeObserver(() => {
        observer.disconnect()
        if (stopped) return
        samples.push({ value: frame.sample(startedAt) })
        channel.port2.postMessage(undefined)
      })
      observer.observe(sentinel)
    }
    requestAnimationFrame(callback)
    return stop
  }
  window.__claxedoPaintedFrames = paintedFrames
}
