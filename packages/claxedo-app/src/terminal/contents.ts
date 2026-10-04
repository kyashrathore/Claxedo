import type { WorkbenchStore } from "@/workbench"
import type { TerminalPaneState } from "./model"
import { terminalPaneKind } from "./pane"

export type TerminalContent = { readonly contentId: string; readonly state: TerminalPaneState }

function isTerminalPaneState(value: unknown): value is TerminalPaneState {
  return typeof value === "object" && value !== null && "terminalId" in value && "placementId" in value
}

export function terminalContents(workbench: WorkbenchStore): readonly TerminalContent[] {
  return workbench.selectors.aliveContents().flatMap((contentId) => {
    const opened = workbench.content(contentId)
    const state = opened?.content?.state
    if (opened?.kind.kind !== terminalPaneKind.kind || !isTerminalPaneState(state)) return []
    return [{ contentId, state }]
  })
}
