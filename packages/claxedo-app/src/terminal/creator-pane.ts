import { readString } from "@claxedo/helpers/readers"
import { placementId } from "@/server"
import type { Json, PaneKind } from "@/shell"
import { useTerminalRuntime } from "./context"
import { lazyView } from "@/lib/lazy-view"
import type { TerminalCreatorState } from "./view/terminal-creator"

function decodeCreatorState(value: Json): TerminalCreatorState | undefined {
  const placement = readString(value, "placementId")
  return placement ? { placementId: placementId(placement) } : undefined
}

export const terminalCreatorPaneKind: PaneKind<TerminalCreatorState> = {
  kind: "terminal-new",
  title: () => useTerminalRuntime().newTitle(),
  icon: "terminal",
  view: lazyView(() => import("./view/terminal-creator").then((module) => module.TerminalCreator)),
  encode: (state) => ({ placementId: state.placementId }),
  decode: decodeCreatorState,
}
