import { getFilename } from "@/utils/path"

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
