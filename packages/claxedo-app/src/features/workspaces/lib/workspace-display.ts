import { projectWorkspaceForRef } from "@/platform/identity/project-workspace"
import { getFilename } from "@opencode-ai/ui/utils/path"
import { inventoryHostKind, type InventoryKindWord } from "@/platform/runtime/placement-wire"

export { workspaceRouteIdentity } from "@/platform/identity/workspace-route"

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
    kind?: InventoryKindWord
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
  return projectWorkspaceForRef(project.workspaces, directory)
}

export function workspaceIsCloud(
  project: WorkspaceDisplayProject,
  directory: string,
  input?: { mainIsCloud?: boolean },
) {
  const workspace = projectWorkspace(project, directory)
  if (workspace) return inventoryHostKind(workspace.kind) === "provisioner"
  if (directory === project.worktree) return !!input?.mainIsCloud
  return false
}

export function workspaceDisplayName(
  project: WorkspaceDisplayProject,
  directory: string,
) {
  const workspace = projectWorkspace(project, directory)
  const raw = directory === project.worktree
    ? workspace?.workspace_name ?? "main"
    : workspace?.workspace_name ?? getFilename(directory)
  return raw
}
