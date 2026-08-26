import { signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"

type ProjectInventory = {
  worktree: string
  sandboxes?: string[]
}

export function projectForDirectory<T extends ProjectInventory>(projects: readonly T[], directory: T["worktree"]) {
  const local = projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))
  if (local) return local
  return projects.find((project) => !!signedWorkspaceFromProjects([project], directory))
}

export function projectWorktreeForDirectory<T extends ProjectInventory>(
  projects: readonly T[],
  directory: T["worktree"],
) {
  return projectForDirectory(projects, directory)?.worktree
}
