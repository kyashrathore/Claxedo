import { getFilename } from "@/lib/path"

export type WorkspaceDisplayProject = {
  id: string
  name?: string | null
  worktree: string
  sandboxes?: string[]
  workspaces?: Record<string, {
    id?: string
    workspaceId?: string
    directory?: string
    workspace_name?: string | null
    kind?: "local" | "cloud" | "user-hosted"
    available?: boolean
  }>
}

export function projectDisplayName(project: WorkspaceDisplayProject) {
  return project.name ?? getFilename(project.worktree)
}

export function projectWorkspaceDirectories(project: WorkspaceDisplayProject) {
  const workspaceDirectory = (key: string) => project.workspaces?.[key]?.directory ?? key
  return [...new Set<string>([
    project.worktree,
    ...(project.sandboxes ?? []).map(workspaceDirectory),
    ...Object.entries(project.workspaces ?? {}).map(([key, workspace]) => workspace.directory ?? key),
  ])]
}

function projectWorkspace(project: WorkspaceDisplayProject, directory: string) {
  return project.workspaces?.[directory] ??
    Object.values(project.workspaces ?? {}).find((workspace) =>
      workspace.directory === directory ||
      workspace.id === directory ||
      workspace.workspaceId === directory
    )
}

// The `workspaces` map is keyed inconsistently: sometimes by workspace id,
// sometimes by the workspace's own directory (user-hosted records especially).
// A key that equals the record's own `directory` is therefore a directory, not
// an id, and must never be reported as one: `/w/:workspaceId` would render
// `/w/%2Fprivate%2Ftmp%2F...`, leaking the host's path layout into a shareable
// URL, and the app-shell canonicalizer would compare that path against itself,
// conclude the URL was already canonical, and never rewrite it.
//
// This is a STRUCTURAL comparison rather than a filesystem-path sniff on
// purpose — the shape predicates are pinned debt (`architecture/debt-ratchet`),
// and comparing the key against the record's resolved directory is both cheaper
// and correct for non-path directory keys too. Note the key IS the directory
// when `directory` is absent, which is exactly the id-less user-hosted case.
export function workspaceRouteIdentity(projects: WorkspaceDisplayProject[], routeKey: string | undefined) {
  if (!routeKey) return
  return projects
    .flatMap((project) => Object.entries(project.workspaces ?? {}))
    .map(([key, workspace]) => {
      const resolved = workspace.directory ?? key
      const explicit = workspace.id ?? workspace.workspaceId
      return {
        routeId: explicit ?? (key === resolved ? undefined : key),
        directory: resolved,
      }
    })
    .find((workspace) => routeKey === workspace.routeId || routeKey === workspace.directory)
}

export function workspaceIsCloud(
  project: WorkspaceDisplayProject,
  directory: string,
  input?: { mainIsCloud?: boolean },
) {
  const workspace = projectWorkspace(project, directory)
  if (workspace) return workspace.kind === "cloud"
  if (directory === project.worktree) return !!input?.mainIsCloud
  return false
}

export function workspaceDisplayName(
  project: WorkspaceDisplayProject,
  directory: string,
  input?: { mainIsCloud?: boolean; cloud?: boolean },
) {
  const workspace = projectWorkspace(project, directory)
  const raw = directory === project.worktree
    ? workspace?.workspace_name ?? "main"
    : workspace?.workspace_name ?? getFilename(directory)
  return raw
}
