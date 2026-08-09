import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import {
  workspaceResponse as projectWorkspaceResponse,
  type WorkspaceResponse,
} from "@claxedo/server-core/workspace/store/response"
import { getSupervisorSandboxStatus } from "./supervisor"

/**
 * Canonical JSON projection returned by `GET /api/workspace/resolve`.
 *
 * Keep this projection separate from the route adapter so consumers that need to
 * contract-check a response (notably the Tier-M e2e runtime) can call the same
 * producer instead of copying its field list.
 */
export function workspaceResponse(ws: Workspace | undefined) {
  if (!ws) return
  const live = getSupervisorSandboxStatus(ws.id)
  const stopped = live === "stopped" ? "stopped" : undefined
  return projectWorkspaceResponse(ws, stopped)
}

export type { WorkspaceResponse }
