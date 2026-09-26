import { readString } from "@/lib/record"
import { placementId } from "@/server"
import type { Json, PaneKind } from "@/shell"
import { useTerminalRuntime } from "./context"
import { TerminalCreator, type TerminalCreatorState } from "./view/terminal-creator"

function decodeCreatorState(value: Json): TerminalCreatorState | undefined {
  const placement = readString(value, "placementId")
  return placement ? { placementId: placementId(placement) } : undefined
}

export const terminalCreatorPaneKind: PaneKind<TerminalCreatorState> = {
  kind: "terminal-new",
  title: () => useTerminalRuntime().newTitle(),
  icon: "terminal",
  view: TerminalCreator,
  encode: (state) => ({ placementId: state.placementId }),
  decode: decodeCreatorState,
}
