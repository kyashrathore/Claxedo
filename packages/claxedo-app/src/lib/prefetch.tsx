import { createContext, createEffect, createSignal, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"
import { afterNextPaint } from "./after-paint"
import { nextIdleSlice } from "./idle"

export type PrefetchGate = {
  readonly hold: (pending: Accessor<boolean>) => () => void
  readonly open: Accessor<boolean>
}

export type QuietMoment = (run: () => void) => () => void

export const idleAfterNextPaint: QuietMoment = (run) => {
  let wanted = true
  const cancel = afterNextPaint(() => void nextIdleSlice().then(() => wanted && run()))
  return () => {
    wanted = false
    cancel()
  }
}

export function createPrefetchGate(): PrefetchGate {
  const [holds, setHolds] = createSignal<readonly Accessor<boolean>[]>([])
  return {
    hold: (pending) => {
      setHolds((current) => [...current, pending])
      return () => setHolds((current) => current.filter((held) => held !== pending))
    },
    open: () => holds().every((pending) => !pending()),
  }
}

export function createSettledPrefetch(gate: PrefetchGate, load: () => Promise<unknown>, failure: string, quiet: QuietMoment = idleAfterNextPaint): void {
  const [settled, setSettled] = createSignal(false)
  createEffect(() => {
    if (settled() || !gate.open()) return
    onCleanup(quiet(() => setSettled(true)))
  })
  createEffect(() => {
    if (settled()) void load().catch((error: unknown) => console.warn(failure, { error }))
  })
}

const PrefetchContext = createContext<PrefetchGate>()

export function PrefetchProvider(props: ParentProps) {
  return <PrefetchContext.Provider value={createPrefetchGate()}>{props.children}</PrefetchContext.Provider>
}

function usePrefetchGate(): PrefetchGate {
  const gate = useContext(PrefetchContext)
  if (!gate) throw new Error("prefetching needs a PrefetchProvider above it")
  return gate
}

export function holdPrefetch(pending: Accessor<boolean>): void {
  onCleanup(usePrefetchGate().hold(pending))
}

export function prefetchWhenSettled(load: () => Promise<unknown>, failure: string): void {
  createSettledPrefetch(usePrefetchGate(), load, failure)
}
