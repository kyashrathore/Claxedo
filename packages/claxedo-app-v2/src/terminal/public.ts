import type { PlacementId, TerminalAgentStatus, TerminalId } from "@/server"
import { useWorkbench } from "@/workbench"
import { useEndTerminal } from "./close"
import { useTerminalRuntime } from "./context"
import { terminalCreatorPaneKind } from "./creator-pane"
import type { TerminalPaneState } from "./model"
import { terminalPaneKind } from "./pane"
import type { TerminalLaunch } from "./store"

export type TerminalItem = {
  readonly placementId: PlacementId
  readonly terminalId: TerminalId
  readonly title: string
  readonly agentStatus?: TerminalAgentStatus
}

export type TerminalList = {
  readonly items: (placementId: PlacementId) => readonly TerminalItem[]
  readonly retain: (placementId: PlacementId) => () => void
  readonly createTerminal: (placementId: PlacementId, launch?: TerminalLaunch) => Promise<TerminalId>
  readonly open: (placementId: PlacementId, terminalId: TerminalId) => void
  readonly close: (placementId: PlacementId, terminalId: TerminalId) => void
  readonly startNew: (placementId: PlacementId) => void
}

function isTerminalPaneState(value: unknown): value is TerminalPaneState {
  return typeof value === "object" && value !== null && "terminalId" in value && "placementId" in value
}

export function useTerminals(): TerminalList {
  const runtime = useTerminalRuntime()
  const workbench = useWorkbench()
  const end = useEndTerminal(runtime)
  const contentOf = (terminalId: TerminalId) =>
    workbench.selectors.aliveContents().find((contentId) => {
      const opened = workbench.content(contentId)
      return (
        opened?.kind.kind === terminalPaneKind.kind &&
        isTerminalPaneState(opened.state) &&
        opened.state.terminalId === terminalId
      )
    })
  return {
    items: (placementId) =>
      runtime
        .store(placementId)
        .rows()
        .map((row) => ({
          placementId,
          terminalId: row.id,
          title: row.title,
          ...(row.agentStatus ? { agentStatus: row.agentStatus } : {}),
        })),
    retain: runtime.retain,
    createTerminal: async (placementId, launch) => (await runtime.store(placementId).create(launch)).id,
    open: (placementId, terminalId) => runtime.open({ placementId, terminalId }),
    close: (placementId, terminalId) => {
      const contentId = contentOf(terminalId)
      if (contentId) workbench.closeContent(contentId)
      else void end({ placementId, terminalId })
    },
    startNew: (placementId) => void workbench.openPane(terminalCreatorPaneKind, { placementId }),
  }
}
