import { createContext, createEffect, createSignal, onCleanup, useContext, type JSX, type ParentProps } from "solid-js"

type PanelSlot = { readonly inset: number; readonly panel: JSX.Element }

export const SidePanelSlotContext = createContext<(slot: PanelSlot) => () => void>()
const SidePanelActiveContext = createContext<() => boolean>(() => true)

export function createSidePanelSlot() {
  const [slot, setSlot] = createSignal<PanelSlot>()
  const register = (value: PanelSlot) => {
    setSlot(value)
    return () => setSlot((current) => (current === value ? undefined : current))
  }
  return { slot, register }
}

export function SidePanelScope(props: ParentProps<{ readonly active: boolean }>): JSX.Element {
  return <SidePanelActiveContext.Provider value={() => props.active}>{props.children}</SidePanelActiveContext.Provider>
}

export function SidePanelSlot(props: PanelSlot): JSX.Element {
  const register = useContext(SidePanelSlotContext)
  const active = useContext(SidePanelActiveContext)
  if (!register) throw new Error("SidePanelSlot needs a SidePanelArea above it")
  createEffect(() => {
    if (active()) onCleanup(register(props))
  })
  return null
}
