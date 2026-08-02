import type { Workspace } from "../../workspace/store"

export function resolveClaxedoWorkspaceRuntimeTarget(workspace: Workspace) {
  return {
    workspaceId: workspace.id,
    directory: workspace.directory,
  }
}
