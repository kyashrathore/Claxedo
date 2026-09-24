import { createContext, useContext, type Accessor } from "solid-js"
import type { WorkspaceFileFocusTarget } from "@/lib/workspace-file-focus"
import type { PlacementId } from "@/server"
import type { RendererBudget } from "./backend/renderer-budget"
import type { TerminalPaneState } from "./model"
import type { TerminalStore } from "./store"

export type Terminals = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly renderers: RendererBudget
  readonly store: (placementId: PlacementId) => TerminalStore
  readonly retain: (placementId: PlacementId) => () => void
  readonly defaultTitle: () => string
  readonly open: (state: TerminalPaneState, paneId?: string) => void
  readonly openFile: (target: WorkspaceFileFocusTarget) => void
}

export const TerminalsContext = createContext<Terminals>()

export function useTerminals(): Terminals {
  const terminals = useContext(TerminalsContext)
  if (!terminals) throw new Error("useTerminals needs a TerminalProvider above it")
  return terminals
}
