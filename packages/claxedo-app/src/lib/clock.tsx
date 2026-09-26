import { createContext, createEffect, createMemo, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"
import { createAgeClock, type AgeClock } from "./age-clock"
import { createSecondTicker, type SecondTicker } from "./second-ticker"

type Clock = { readonly ages: AgeClock; readonly seconds: SecondTicker }

const ClockContext = createContext<Clock>()

export function ClockProvider(props: ParentProps) {
  const ages = createAgeClock()
  const seconds = createSecondTicker()
  const followVisibility = () => (document.hidden ? ages.pause() : ages.resume())
  document.addEventListener("visibilitychange", followVisibility)
  if (document.hidden) ages.pause()
  onCleanup(() => {
    document.removeEventListener("visibilitychange", followVisibility)
    ages.dispose()
    seconds.dispose()
  })
  return <ClockContext.Provider value={{ ages, seconds }}>{props.children}</ClockContext.Provider>
}

function useClockContext(): Clock {
  const clock = useContext(ClockContext)
  if (!clock) throw new Error("the clock needs a ClockProvider above it")
  return clock
}

export function useAgeClock(at: Accessor<number | undefined>): Accessor<number> {
  const { ages } = useClockContext()
  const watched = createMemo(() => {
    const since = at()
    if (since === undefined) return undefined
    const watch = ages.watch(since)
    onCleanup(watch.release)
    return watch.now
  })
  return () => watched()?.() ?? Date.now()
}

export function useSecondClock(active: Accessor<boolean>): Accessor<number> {
  const { seconds } = useClockContext()
  createEffect(() => {
    if (!active()) return
    onCleanup(seconds.subscribe())
  })
  return seconds.second
}
