import { placementId, terminalId } from "@/server"
import type { Json, PaneKind } from "@/shell"
import { useTerminals } from "./context"
import type { TerminalPaneState } from "./model"
import { TerminalPane } from "./view/terminal-pane"

function isJsonObject(value: Json): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function decodeTerminalPaneState(value: Json): TerminalPaneState | undefined {
  if (!isJsonObject(value)) return undefined
  const placement = value.placementId
  const terminal = value.terminalId
  if (typeof placement !== "string" || typeof terminal !== "string" || !placement || !terminal) return undefined
  return { placementId: placementId(placement), terminalId: terminalId(terminal) }
}

export const terminalPaneKind: PaneKind<TerminalPaneState> = {
  kind: "terminal",
  title: (state) => {
    const terminals = useTerminals()
    return terminals.store(state.placementId).row(state.terminalId)?.title ?? terminals.defaultTitle()
  },
  icon: "terminal",
  view: TerminalPane,
  encode: (state) => ({ placementId: state.placementId, terminalId: state.terminalId }),
  decode: decodeTerminalPaneState,
  fromRoute: (route) =>
    route.kind === "terminal" ? { placementId: route.placementId, terminalId: route.terminalId } : undefined,
  toRoute: (state) => ({ kind: "terminal", placementId: state.placementId, terminalId: state.terminalId }),
}
