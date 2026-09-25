import { createContext, createEffect, createSignal, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"
import { createSecondTicker, type SecondTicker } from "./second-ticker"

export const CLOCK_TICK_MS = 10_000

type Clock = { readonly now: Accessor<number>; readonly seconds: SecondTicker }

const ClockContext = createContext<Clock>()

export function ClockProvider(props: ParentProps) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
  const seconds = createSecondTicker()
  onCleanup(() => {
    clearInterval(timer)
    seconds.dispose()
  })
  return <ClockContext.Provider value={{ now, seconds }}>{props.children}</ClockContext.Provider>
}

function useClockContext(): Clock {
  const clock = useContext(ClockContext)
  if (!clock) throw new Error("useClock needs a ClockProvider above it")
  return clock
}

export function useClock(): Accessor<number> {
  return useClockContext().now
}

export function useSecondClock(active: Accessor<boolean>): Accessor<number> {
  const { seconds } = useClockContext()
  createEffect(() => {
    if (!active()) return
    onCleanup(seconds.subscribe())
  })
  return seconds.second
}
