export const INPUT_DEBOUNCE_MS = 250

export type DebounceTimer = (run: () => void, delayMs: number) => () => void

export type InputDebounce<Value> = {
  readonly schedule: (value: Value) => void
  readonly flush: () => void
  readonly cancel: () => void
}

const browserTimer: DebounceTimer = (run, delayMs) => {
  const handle = setTimeout(run, delayMs)
  return () => clearTimeout(handle)
}

export function createInputDebounce<Value>(onSettled: (value: Value) => void, timer: DebounceTimer = browserTimer, delayMs = INPUT_DEBOUNCE_MS): InputDebounce<Value> {
  let stop: (() => void) | undefined
  let pending: { readonly value: Value } | undefined
  const cancel = () => {
    stop?.()
    stop = undefined
    pending = undefined
  }
  const flush = () => {
    const settled = pending
    cancel()
    if (settled) onSettled(settled.value)
  }
  return {
    schedule: (value) => {
      stop?.()
      pending = { value }
      stop = timer(flush, delayMs)
    },
    flush,
    cancel,
  }
}
