export type ScrollState = {
  readonly overflow: boolean
  readonly bottom: boolean
  readonly jump: boolean
}

export function computeScrollState(metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }): ScrollState {
  const max = metrics.scrollHeight - metrics.clientHeight
  const overflow = max > 1
  const bottom = !overflow || metrics.scrollTop >= max - 2
  const jump = overflow && max - metrics.scrollTop > Math.max(400, metrics.clientHeight)
  return { overflow, bottom, jump }
}
