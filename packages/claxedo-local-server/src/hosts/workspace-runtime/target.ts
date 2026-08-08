import type { Workspace } from "@claxedo/server-core/workspace/store/index"

export function resolveClaxedoWorkspaceRuntimeTarget(workspace: Workspace) {
  return {
    workspaceId: workspace.id,
    directory: workspace.directory,
  }
}
