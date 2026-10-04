import { createContext, useContext, type Accessor } from "solid-js"
import type { WorkspaceFileFocusTarget } from "@/lib/workspace-file-focus"
import type { PlacementId } from "@/server"
import type { RendererBudget } from "./backend/renderer-budget"
import type { TerminalPaneState } from "./model"
import type { OpenSession, TerminalStore } from "./store"

export type Terminals = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly openSession: () => OpenSession | undefined
  readonly renderers: RendererBudget
  readonly store: (placementId: PlacementId) => TerminalStore
  readonly retain: (placementId: PlacementId) => () => void
  readonly defaultTitle: () => string
  readonly newTitle: () => string
  readonly open: (state: TerminalPaneState, paneId?: string) => void
  readonly openFile: (target: WorkspaceFileFocusTarget) => void
}

export const TerminalsContext = createContext<Terminals>()

export function useTerminalRuntime(): Terminals {
  const terminals = useContext(TerminalsContext)
  if (!terminals) throw new Error("useTerminalRuntime needs a TerminalProvider above it")
  return terminals
}
