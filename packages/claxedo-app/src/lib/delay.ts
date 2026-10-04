import { createSignal, onCleanup, type Accessor } from "solid-js"

export const PLACEHOLDER_DELAY_MS = 50

export const SLOW_LOAD_MS = 2_000

export function useElapsed(ms: number = PLACEHOLDER_DELAY_MS): Accessor<boolean> {
  const [elapsed, setElapsed] = createSignal(false)
  const timer = setTimeout(() => setElapsed(true), ms)
  onCleanup(() => clearTimeout(timer))
  return elapsed
}
