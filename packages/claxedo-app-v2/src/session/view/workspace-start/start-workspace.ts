import { machine } from "@/lib/machine"
import { toAppError, type PlacementId, type Server } from "@/server"
import { workspaceStartTransition, type WorkspaceStartState } from "./model"

export type WorkspaceStart = {
  readonly state: () => WorkspaceStartState
  readonly start: () => Promise<void>
}

export function createWorkspaceStart(server: Server, placementId: () => PlacementId): WorkspaceStart {
  const flow = machine<WorkspaceStartState, Parameters<typeof workspaceStartTransition>[1]>({ kind: "stopped" }, workspaceStartTransition)
  const start = async () => {
    if (flow.state().kind === "starting") return
    flow.send({ type: "startRequested" })
    try {
      await server.cloud.start(placementId(), { onProgress: (progress) => flow.send({ type: "provisioning", ...(progress.bootMode ? { bootMode: progress.bootMode } : {}) }) })
      flow.send({ type: "started" })
    } catch (cause) {
      flow.send({ type: "startFailed", error: toAppError(cause) })
    }
  }
  return { state: flow.state, start }
}
