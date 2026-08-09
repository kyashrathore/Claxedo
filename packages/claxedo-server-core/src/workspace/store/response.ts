import type { Workspace } from "./index"
import { workspaceBacking } from "./backing"

/** Product-neutral JSON projection returned by workspace resolve routes. */
export function workspaceResponse(ws: Workspace | undefined, statusOverride?: string) {
  if (!ws) return
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
    status: statusOverride ?? ws.status ?? null,
    git: {
      repo: ws.repo_name ?? null,
      branch: ws.git_branch ?? null,
      remote: ws.git_remote ?? null,
    },
  }
}

export type WorkspaceResponse = NonNullable<ReturnType<typeof workspaceResponse>>
