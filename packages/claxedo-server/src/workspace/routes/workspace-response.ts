import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { workspaceBacking } from "../../workspace/store/backing"
import { getSupervisorSandboxStatus } from "../../workspace/supervisor"

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
  const backing = workspaceBacking(ws)
  const access = backing.kind === "cloud-vm" ? "cloud" : backing.kind === "user-hosted" ? "user-hosted" : "local"
  return {
    workspaceId: ws.id,
    projectId: ws.project_id ?? ws.id,
    directory: backing.kind === "local-worktree" ? ws.directory : (ws.remote_directory ?? ws.directory),
    workspaceName: ws.workspace_name ?? null,
    access,
    backing,
    kind: ws.kind,
    driver: ws.driver ?? null,
    status: stopped ?? ws.status ?? null,
    git: {
      repo: ws.repo_name ?? null,
      branch: ws.git_branch ?? null,
      remote: ws.git_remote ?? null,
    },
  }
}

export type WorkspaceResponse = NonNullable<ReturnType<typeof workspaceResponse>>
