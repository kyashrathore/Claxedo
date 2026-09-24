import { createContext, createEffect, on, useContext, type Accessor, type JSX } from "solid-js"
import { usePhone } from "@/lib/viewport"
import { createShellLayout, panelShown, sidebarShown, type ShellLayoutEvent, type ShellLayoutState } from "./model"
import {
  clampWidth,
  createShellPreferences,
  defaultPanel,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type PanelPreference,
} from "./store"

export type ShellLayout = {
  readonly state: Accessor<ShellLayoutState>
  readonly send: (event: ShellLayoutEvent) => void
  readonly phone: Accessor<boolean>
  readonly sidebarShown: Accessor<boolean>
  readonly panelShown: Accessor<boolean>
  readonly sidebarWidth: Accessor<number>
  readonly setSidebarWidth: (width: number) => void
  readonly panel: (scope: string) => PanelPreference
  readonly setPanelWidth: (scope: string, width: number) => void
  readonly setPanelTab: (scope: string, tab: string) => void
}

const ShellLayoutContext = createContext<ShellLayout>()

export function ShellLayoutProvider(props: { readonly scope: string; readonly children: JSX.Element }): JSX.Element {
  const phone = usePhone()
  const [prefs, setPrefs] = createShellPreferences(props.scope)
  const machine = createShellLayout(phone(), { sidebar: prefs.sidebar, panel: prefs.panel })

  const send = (event: ShellLayoutEvent) => {
    machine.send(event)
    const state = machine.state()
    if (state.kind !== "wide") return
    setPrefs({ sidebar: state.sidebar, panel: state.panel })
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
    panelShown: () => panelShown(machine.state()),
    sidebarWidth: () => prefs.sidebarWidth,
    setSidebarWidth: (width) => setPrefs("sidebarWidth", clampWidth(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)),
    panel: (scope) => prefs.panels[scope] ?? defaultPanel,
    setPanelWidth: (scope, width) =>
      setPrefs("panels", scope, (current) => ({ ...(current ?? defaultPanel), width: clampWidth(width, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH) })),
    setPanelTab: (scope, tab) => setPrefs("panels", scope, (current) => ({ ...(current ?? defaultPanel), tab })),
  }
  return <ShellLayoutContext.Provider value={layout}>{props.children}</ShellLayoutContext.Provider>
}

export function useShellLayout(): ShellLayout {
  const layout = useContext(ShellLayoutContext)
  if (!layout) throw new Error("useShellLayout needs a ShellLayoutProvider above it")
  return layout
}
