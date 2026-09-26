import { createSignal, type Accessor } from "solid-js"

export const SECOND_TICK_MS = 1_000

export type SecondTicker = {
  readonly second: Accessor<number>
  readonly subscribe: () => () => void
  readonly dispose: () => void
}

export function createSecondTicker(): SecondTicker {
  const [second, setSecond] = createSignal(Date.now())
  let readers = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    clearInterval(timer)
    timer = undefined
  }
  const subscribe = () => {
    readers += 1
    setSecond(Date.now())
    timer ??= setInterval(() => setSecond(Date.now()), SECOND_TICK_MS)
    let released = false
    return () => {
      if (released) return
      released = true
      readers -= 1
      if (readers === 0) stop()
    }
  }
  return { second, subscribe, dispose: stop }
}
