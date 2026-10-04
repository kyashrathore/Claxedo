import { readString } from "@claxedo/helpers/readers"
import { placementId, terminalId } from "@/server"
import type { Json, PaneKind } from "@/shell"
import { useTerminalRuntime } from "./context"
import type { TerminalPaneState } from "./model"
import { TerminalPane } from "./view/terminal-pane"

function decodeTerminalPaneState(value: Json): TerminalPaneState | undefined {
  const placement = readString(value, "placementId")
  const terminal = readString(value, "terminalId")
  if (!placement || !terminal) return undefined
  return { placementId: placementId(placement), terminalId: terminalId(terminal) }
}

export const terminalPaneKind: PaneKind<TerminalPaneState> = {
  kind: "terminal",
  keepMounted: true,
  title: (state) => {
    const terminals = useTerminalRuntime()
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
