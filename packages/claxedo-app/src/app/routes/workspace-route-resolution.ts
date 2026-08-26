import type { ShellRoute } from "@/platform/identity/route"
import type { WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-query"

export type WorkspaceRouteResolution = {
  directory: NonNullable<WorkspaceRuntimeSnapshot["directory"]>
  workspaceId?: string
}

export function shellRouteWorkspaceId(route: ShellRoute) {
  switch (route.kind) {
    case "workspace":
    case "workspaceWorkGraph":
    case "workspace-session":
    case "workspace-page":
    case "workspace-terminal":
      return route.workspaceId
    case "newTask":
      return route.workspaceId
    default:
      return undefined
  }
}

export function resolveWorkspaceRoute(
  route: ShellRoute,
  workspace: WorkspaceRuntimeSnapshot | null | undefined,
): WorkspaceRouteResolution | undefined {
  if (route.kind === "legacy-directory") return { directory: route.directory }

  const workspaceId = shellRouteWorkspaceId(route)
  if (!workspaceId || workspace?.workspaceId !== workspaceId || !workspace.directory) return
  return {
    workspaceId,
    directory: workspace.directory,
  }
}
