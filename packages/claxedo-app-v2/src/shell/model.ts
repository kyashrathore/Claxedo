import { machine, unreachable, type Machine } from "@/lib/machine"

export type SideRegion = "open" | "collapsed"

export type SidebarRegion = SideRegion | "peeking"

export type PhoneOverlay = "open" | "closed"

export type ShellLayoutState =
  | { readonly kind: "wide"; readonly sidebar: SidebarRegion; readonly panel: SideRegion }
  | { readonly kind: "phone"; readonly drawer: PhoneOverlay; readonly sheet: PhoneOverlay }

export type ShellLayoutEvent =
  | { readonly type: "viewportChanged"; readonly phone: boolean; readonly wide: WideRegions }
  | { readonly type: "toggleSidebar" }
  | { readonly type: "showSidebar" }
  | { readonly type: "hideSidebar" }
  | { readonly type: "peekSidebar" }
  | { readonly type: "unpeekSidebar" }
  | { readonly type: "togglePanel" }
  | { readonly type: "showPanel" }
  | { readonly type: "hidePanel" }
  | { readonly type: "navigated" }

export type WideRegions = { readonly sidebar: SideRegion; readonly panel: SideRegion }

const flipRegion = (region: SidebarRegion): SideRegion => (region === "open" ? "collapsed" : "open")

const flipOverlay = (overlay: PhoneOverlay): PhoneOverlay => (overlay === "open" ? "closed" : "open")

function wideTransition(state: Extract<ShellLayoutState, { kind: "wide" }>, event: ShellLayoutEvent): ShellLayoutState {
  switch (event.type) {
    case "viewportChanged":
      return event.phone ? { kind: "phone", drawer: "closed", sheet: "closed" } : state
    case "toggleSidebar":
      return { ...state, sidebar: flipRegion(state.sidebar) }
    case "showSidebar":
      return { ...state, sidebar: "open" }
    case "hideSidebar":
      return { ...state, sidebar: "collapsed" }
    case "peekSidebar":
      return state.sidebar === "collapsed" ? { ...state, sidebar: "peeking" } : state
    case "unpeekSidebar":
      return state.sidebar === "peeking" ? { ...state, sidebar: "collapsed" } : state
    case "togglePanel":
      return { ...state, panel: flipRegion(state.panel) }
    case "showPanel":
      return { ...state, panel: "open" }
    case "hidePanel":
      return { ...state, panel: "collapsed" }
    case "navigated":
      return state
    default:
      return unreachable(event)
  }
}

function phoneTransition(state: Extract<ShellLayoutState, { kind: "phone" }>, event: ShellLayoutEvent): ShellLayoutState {
  switch (event.type) {
    case "viewportChanged":
      return event.phone ? state : { kind: "wide", ...event.wide }
    case "toggleSidebar":
      return { kind: "phone", drawer: flipOverlay(state.drawer), sheet: "closed" }
    case "showSidebar":
      return { kind: "phone", drawer: "open", sheet: "closed" }
    case "hideSidebar":
      return { ...state, drawer: "closed" }
    case "peekSidebar":
    case "unpeekSidebar":
      return state
    case "togglePanel":
      return { kind: "phone", drawer: "closed", sheet: flipOverlay(state.sheet) }
    case "showPanel":
      return { kind: "phone", drawer: "closed", sheet: "open" }
    case "hidePanel":
      return { ...state, sheet: "closed" }
    case "navigated":
      return { kind: "phone", drawer: "closed", sheet: "closed" }
    default:
      return unreachable(event)
  }
}

export function transition(state: ShellLayoutState, event: ShellLayoutEvent): ShellLayoutState {
  switch (state.kind) {
    case "wide":
      return wideTransition(state, event)
    case "phone":
      return phoneTransition(state, event)
    default:
      return unreachable(state)
  }
}

export function createShellLayout(phone: boolean, wide: WideRegions): Machine<ShellLayoutState, ShellLayoutEvent> {
  const initial: ShellLayoutState = phone ? { kind: "phone", drawer: "closed", sheet: "closed" } : { kind: "wide", ...wide }
  return machine(initial, transition)
}

export function sidebarShown(state: ShellLayoutState): boolean {
  return state.kind === "wide" ? state.sidebar !== "collapsed" : state.drawer === "open"
}

export function sidebarPinned(state: ShellLayoutState): boolean {
  return state.kind === "phone" || state.sidebar === "open"
}

export function persistedSidebar(region: SidebarRegion): SideRegion {
  return region === "open" ? "open" : "collapsed"
}

export function panelShown(state: ShellLayoutState): boolean {
  return state.kind === "wide" ? state.panel === "open" : state.sheet === "open"
}
