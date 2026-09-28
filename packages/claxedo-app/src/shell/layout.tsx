import { createContext, createEffect, createSignal, on, useContext, type Accessor, type JSX } from "solid-js"
import { usePhone } from "@/lib/viewport"
import { createShellLayout, panelOpen, persistedSidebar, sidebarPinned, sidebarShown, type ShellLayoutEvent, type ShellLayoutState } from "./model"
import { clampWidth, createShellPreferences, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./store"
import { usePageTabFocused } from "./view/page-tab"

export type ShellLayout = {
  readonly state: Accessor<ShellLayoutState>
  readonly send: (event: ShellLayoutEvent) => void
  readonly phone: Accessor<boolean>
  readonly sidebarShown: Accessor<boolean>
  readonly sidebarPinned: Accessor<boolean>
  readonly peekMuted: Accessor<boolean>
  readonly unmutePeek: () => void
  readonly panelOpen: Accessor<boolean>
  readonly panelAllowed: Accessor<boolean>
  readonly panelShown: Accessor<boolean>
  readonly sidebarWidth: Accessor<number>
  readonly setSidebarWidth: (width: number) => void
}

const ShellLayoutContext = createContext<ShellLayout>()

export function ShellLayoutProvider(props: { readonly scope: string; readonly children: JSX.Element }): JSX.Element {
  const phone = usePhone()
  const [prefs, setPrefs] = createShellPreferences(props.scope)
  const machine = createShellLayout(phone(), { sidebar: prefs.sidebar, panel: prefs.panel })

  const [peekMuted, setPeekMuted] = createSignal(false)
  const pageTabFocused = usePageTabFocused()
  const panelAllowed = () => !pageTabFocused()

  const send = (event: ShellLayoutEvent) => {
    if (event.type === "toggleSidebar") setPeekMuted(sidebarPinned(machine.state()))
    machine.send(event)
    const state = machine.state()
    if (state.kind !== "wide") return
    setPrefs({ sidebar: persistedSidebar(state.sidebar), panel: state.panel })
  }
  createEffect(on(phone, (isPhone, previous) => {
    if (previous === undefined) return
    send({ type: "viewportChanged", phone: isPhone, wide: { sidebar: prefs.sidebar, panel: prefs.panel } })
  }))

  const layout: ShellLayout = {
    state: machine.state,
    send,
    phone,
    sidebarShown: () => sidebarShown(machine.state()),
    sidebarPinned: () => sidebarPinned(machine.state()),
    peekMuted,
    unmutePeek: () => setPeekMuted(false),
    panelOpen: () => panelOpen(machine.state()),
    panelAllowed,
    panelShown: () => panelAllowed() && panelOpen(machine.state()),
    sidebarWidth: () => prefs.sidebarWidth,
    setSidebarWidth: (width) => setPrefs("sidebarWidth", clampWidth(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)),
  }
  return <ShellLayoutContext.Provider value={layout}>{props.children}</ShellLayoutContext.Provider>
}

export function useShellLayout(): ShellLayout {
  const layout = useContext(ShellLayoutContext)
  if (!layout) throw new Error("useShellLayout needs a ShellLayoutProvider above it")
  return layout
}
