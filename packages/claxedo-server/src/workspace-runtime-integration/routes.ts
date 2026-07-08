import { WorkspaceRuntimeRoutes, workspaceRuntimeRoute, type WorkspaceRuntimeRouteFamily } from "@claxedo/workspace-runtime/routes"

export const ClaxedoWorkspaceRuntimeRoutes = WorkspaceRuntimeRoutes

export function resolveClaxedoWorkspaceRuntimeRoute(path: string): { family: WorkspaceRuntimeRouteFamily; path: string } | undefined {
  return workspaceRuntimeRoute(path)
}

export function isClaxedoWorkspaceRuntimeRoute(path: string) {
  return !!resolveClaxedoWorkspaceRuntimeRoute(path)
}
