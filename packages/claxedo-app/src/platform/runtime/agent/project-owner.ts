import { sameWorkspaceDirectory, signedWorkspaceFromProjects } from "./signed-workspace"

type ProjectDirectory = string

type ProjectWorkspaceInventory = {
  id?: string
  workspaceId?: string
  kind?: string
  directory?: ProjectDirectory
}

type ProjectInventory = {
  worktree: ProjectDirectory
  sandboxes?: ProjectDirectory[]
  workspaces?: Record<string, ProjectWorkspaceInventory>
}

function workspaceForRef(project: ProjectInventory, ref: ProjectDirectory) {
  const direct = project.workspaces?.[ref]
  if (direct) return direct
  return Object.values(project.workspaces ?? {}).find(
    (workspace) => workspace.id === ref || workspace.workspaceId === ref,
  )
}

function localWorkspaceOwnsDirectory(project: ProjectInventory, directory: ProjectDirectory) {
  return Object.entries(project.workspaces ?? {}).some(([key, workspace]) =>
    workspace.kind === "local" &&
    (key === directory || workspace.id === directory || workspace.workspaceId === directory ||
      sameWorkspaceDirectory(workspace.directory, directory)),
  )
}

export function projectForDirectory<T extends ProjectInventory>(projects: readonly T[], directory: T["worktree"]) {
  const local = projects.find((project) =>
    sameWorkspaceDirectory(project.worktree, directory) ||
    project.sandboxes?.some((sandbox) => sameWorkspaceDirectory(sandbox, directory)) ||
    localWorkspaceOwnsDirectory(project, directory),
  )
  if (local) return local
  return projects.find((project) => !!signedWorkspaceFromProjects([project], directory))
}

/**
 * Whether the project inventory identifies `directory` as a secondary LOCAL
 * git worktree. Local project payloads key `workspaces` by workspace id and put
 * those ids in `sandboxes`, so resolving the sandbox reference is required
 * before comparing its canonical directory.
 */
export function isProjectWorktreeDirectory(project: ProjectInventory, directory: ProjectDirectory) {
  if (sameWorkspaceDirectory(project.worktree, directory)) return false
  return (project.sandboxes ?? []).some((sandbox) => {
    if (sameWorkspaceDirectory(sandbox, directory)) return true
    const workspace = workspaceForRef(project, sandbox)
    return workspace?.kind === "local" && sameWorkspaceDirectory(workspace.directory, directory)
  })
}

export function projectWorktreeForDirectory<T extends ProjectInventory>(
  projects: readonly T[],
  directory: T["worktree"],
) {
  return projectForDirectory(projects, directory)?.worktree
}
