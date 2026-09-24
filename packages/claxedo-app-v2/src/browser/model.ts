import { machine, unreachable, type Machine } from "@/lib/machine"

export type BrowserTabState =
  | { readonly kind: "loading"; readonly url: string }
  | { readonly kind: "ready"; readonly url: string }
  | { readonly kind: "picking"; readonly url: string }
  | { readonly kind: "failed"; readonly url: string; readonly reason: string }

export type BrowserTabEvent =
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "moved"; readonly url: string }
  | { readonly type: "loaded"; readonly url: string }
  | { readonly type: "startPicking" }
  | { readonly type: "stopPicking" }
  | { readonly type: "failed"; readonly reason: string }

export type BrowserTabMachine = Machine<BrowserTabState, BrowserTabEvent>

export function browserTabTransition(state: BrowserTabState, event: BrowserTabEvent): BrowserTabState {
  switch (event.type) {
    case "navigate":
      return { kind: "loading", url: event.url }
    case "moved":
      return { ...state, url: event.url }
    case "loaded":
      return { kind: "ready", url: event.url }
    case "startPicking":
      return state.kind === "ready" ? { kind: "picking", url: state.url } : state
    case "stopPicking":
      return state.kind === "picking" ? { kind: "ready", url: state.url } : state
    case "failed":
      return { kind: "failed", url: state.url, reason: event.reason }
    default:
      return unreachable(event)
  }
}

export function createBrowserTabMachine(url: string): BrowserTabMachine {
  return machine<BrowserTabState, BrowserTabEvent>({ kind: "ready", url }, browserTabTransition)
}

export type BrowserConsoleLevel = "log" | "warn" | "error" | "debug" | "info"

export type BrowserConsoleEntry = {
  readonly id: number
  readonly time: number
  readonly level: BrowserConsoleLevel
  readonly args: readonly string[]
  readonly source: "console" | "exception" | "log"
}

export type BrowserBox = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type BrowserSelection = { readonly selector: string; readonly url: string }

export type PickedElement = {
  readonly id: string
  readonly pageUrl: string
  readonly selector: string
  readonly tagName: string
  readonly outerHtml?: string
  readonly boundingBox?: BrowserBox
  readonly comment: string
  readonly screenshotDataUrl?: string
}

export type BrowserHistory = { readonly canGoBack: boolean; readonly canGoForward: boolean }

export type BrowserAction = "back" | "forward" | "reload" | "hardReload" | "devTools" | "clearCookies"
