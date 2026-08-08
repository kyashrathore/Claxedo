import { WORKSPACE_DIR } from "@claxedo/sandbox-manager/defaults"
import { now } from "./clock"
import { runtimes, type WorkspaceRuntimeState } from "./store"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"

export function runtimeState(ws: Workspace) {
  const hit = runtimes.get(ws.id)
  if (hit) return hit
  const created: WorkspaceRuntimeState = {
    ws,
    status: "stopped",
    used_at: now(),
    crashes: 0,
    retry_at: 0,
    active: 0,
    holds: [],
  }
  runtimes.set(ws.id, created)
  return created
}

export function runtimeWorkspaceDir(ws: Workspace) {
  return ws.kind === "cloud" ? ws.remote_directory || WORKSPACE_DIR : ws.directory
}

export function clearRuntimeStop(state: WorkspaceRuntimeState) {
  if (!state.stop) return
  clearTimeout(state.stop)
  state.stop = undefined
}
