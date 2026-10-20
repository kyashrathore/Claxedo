export type AfterPaint = (run: () => void) => () => void

export const afterNextPaint: AfterPaint = (run) => {
  const channel = new MessageChannel()
  channel.port1.onmessage = () => {
    channel.port1.close()
    run()
  }
  const frame = requestAnimationFrame(() => channel.port2.postMessage(undefined))
  return () => {
    cancelAnimationFrame(frame)
    channel.port1.close()
  }
}
