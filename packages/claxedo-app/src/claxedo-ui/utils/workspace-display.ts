import { getFilename } from "@opencode-ai/util/path"

export type WorkspaceDisplayProject = {
  id: string
  name?: string | null
  worktree: string
  sandboxes?: string[]
  workspaces?: Record<string, { workspace_name?: string | null; kind?: "local" | "cloud"; available?: boolean }>
}

export function projectDisplayName(project: WorkspaceDisplayProject) {
  return project.name ?? getFilename(project.worktree)
}

export function projectWorkspaceDirectories(project: WorkspaceDisplayProject) {
  return [...new Set<string>([
    project.worktree,
    ...(project.sandboxes ?? []),
    ...Object.keys(project.workspaces ?? {}),
  ])]
}

export function workspaceIsCloud(
  project: WorkspaceDisplayProject,
  directory: string,
  input?: { mainIsCloud?: boolean },
) {
  const workspace = project.workspaces?.[directory]
  if (workspace) return workspace.kind === "cloud"
  if (directory === project.worktree) return !!input?.mainIsCloud
  return false
}

export function workspaceDisplayName(
  project: WorkspaceDisplayProject,
  directory: string,
  input?: { mainIsCloud?: boolean; cloud?: boolean },
) {
  const workspace = project.workspaces?.[directory]
  const raw = directory === project.worktree ? "main" : workspace?.workspace_name ?? getFilename(directory)
  const cloud = input?.cloud ?? workspaceIsCloud(project, directory, { mainIsCloud: input?.mainIsCloud })
  return cloud && raw === "main" ? "main (cloud)" : raw
}
