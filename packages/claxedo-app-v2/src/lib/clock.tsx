import { createContext, createSignal, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"

export const CLOCK_TICK_MS = 10_000

const ClockContext = createContext<Accessor<number>>()

export function ClockProvider(props: ParentProps) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
  onCleanup(() => clearInterval(timer))
  return <ClockContext.Provider value={now}>{props.children}</ClockContext.Provider>
}

export function useClock(): Accessor<number> {
  const now = useContext(ClockContext)
  if (!now) throw new Error("useClock needs a ClockProvider above it")
  return now
}
