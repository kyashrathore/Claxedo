export type WorkspaceRouteProject = {
  id?: string | null
  worktree?: string | null
  workspaces?: Record<string, {
    id?: string | null
    workspaceId?: string | null
    directory?: string | null
  }>
}

export function opaqueWorkspaceRouteId(value: string | null | undefined) {
  if (!value || value.includes("/") || value.includes("\\") || value.includes("%")) return
  return value
}

/** Resolve a directory or existing route key to its authoritative workspace id. */
export function workspaceRouteIdentity(projects: readonly WorkspaceRouteProject[], routeKey: string | undefined) {
  if (!routeKey) return

  const directDirectories = new Set<string>()
  let directory: string | undefined
  let matchingProjects = 0
  const workspaceIds = new Set<string>()
  const projectIds = new Set<string>()
  const match = (candidateDirectory: string, candidateRouteId: string | undefined, ids: Set<string>) => {
    if (routeKey !== candidateDirectory) return false
    directory ??= candidateDirectory
    if (candidateRouteId) ids.add(candidateRouteId)
    return true
  }

  for (const project of projects) {
    let matchesProject = false
    const projectRouteId = opaqueWorkspaceRouteId(project.id)
    if (routeKey === projectRouteId && project.worktree) directDirectories.add(project.worktree)
    if (project.worktree) matchesProject = match(project.worktree, projectRouteId, projectIds)
    for (const [key, workspace] of Object.entries(project.workspaces ?? {})) {
      const workspaceDirectory = workspace.directory ?? key
      const routeId = opaqueWorkspaceRouteId(workspace.id ?? workspace.workspaceId)
      if (routeKey === routeId) directDirectories.add(workspaceDirectory)
      matchesProject = match(
        workspaceDirectory,
        routeId,
        workspaceIds,
      ) || matchesProject
    }
    if (matchesProject) matchingProjects++
  }
  if (directDirectories.size === 1) {
    return { routeId: routeKey, directory: directDirectories.values().next().value! }
  }
  if (directDirectories.size > 1) return
  if (!directory) return
  if (matchingProjects > 1) return { routeId: undefined, directory }
  const ids = workspaceIds.size > 0 ? workspaceIds : projectIds
  return { routeId: ids.size === 1 ? ids.values().next().value : undefined, directory }
}

export function workspaceRouteId(projects: readonly WorkspaceRouteProject[], routeKey: string | undefined) {
  return workspaceRouteIdentity(projects, routeKey)?.routeId
}
