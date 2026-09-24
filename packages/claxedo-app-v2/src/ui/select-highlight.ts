import { onCleanup } from "solid-js"

export type SelectHighlight<T> = (item: T) => void | (() => void)

export function createSelectHighlight<T>(keyFor: (item: T) => string, highlight: () => SelectHighlight<T> | undefined) {
  const state: { key?: string; cleanup?: void | (() => void) } = {}

  const stop = () => {
    state.cleanup?.()
    state.cleanup = undefined
    state.key = undefined
  }

  const move = (item: T | undefined) => {
    const handler = highlight()
    if (!handler) return
    if (!item) return stop()
    const key = keyFor(item)
    if (state.key === key) return
    state.cleanup?.()
    state.cleanup = handler(item)
    state.key = key
  }

  onCleanup(stop)

  return { move, stop }
}
