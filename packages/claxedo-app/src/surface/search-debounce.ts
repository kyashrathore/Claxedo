export const COMBOBOX_SEARCH_DEBOUNCE_MS = 250

export type DebounceTimer = (run: () => void, delayMs: number) => () => void

export type SearchDebounce = {
  readonly schedule: (query: string) => void
  readonly cancel: () => void
}

const browserTimer: DebounceTimer = (run, delayMs) => {
  const handle = setTimeout(run, delayMs)
  return () => clearTimeout(handle)
}

export function createSearchDebounce(onSettled: (query: string) => void, timer: DebounceTimer = browserTimer, delayMs = COMBOBOX_SEARCH_DEBOUNCE_MS): SearchDebounce {
  let stop: (() => void) | undefined
  const cancel = () => {
    stop?.()
    stop = undefined
  }
  return {
    schedule: (query) => {
      cancel()
      stop = timer(() => {
        stop = undefined
        onSettled(query)
      }, delayMs)
    },
    cancel,
  }
}
