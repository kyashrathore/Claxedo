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

export type MessageRect = {
  readonly id: string
  readonly top: number
  readonly bottom: number
}

export function pickAnchorMessageId(input: {
  items: readonly MessageRect[]
  box: { top: number; bottom: number }
  line: number
  fallback?: string
}): string | undefined {
  const { items, box, line } = input
  const shown = items.filter((item) => item.bottom > box.top && item.top < box.bottom)
  const hit = shown.find((item) => item.top <= line && item.bottom >= line)
  if (hit) return hit.id
  const near = [...shown].sort((a, b) => {
    const da = Math.abs(a.top - line)
    const db = Math.abs(b.top - line)
    if (da !== db) return da - db
    return a.top - b.top
  })[0]
  if (near) return near.id
  return items.filter((item) => item.top <= line).at(-1)?.id ?? items[0]?.id ?? input.fallback
}
