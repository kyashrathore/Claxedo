import { getFilename } from "@/lib/path"

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

/**
 * The catalog row a workspace REF names, whichever identity the ref carries.
 *
 * One workspace is reachable under several. A relay-backed workspace is keyed
 * — and addressed — by `workspace:<id>`, the same form `sessionRowDirectory`
 * stamps on its session rows; a local one by its filesystem path. Either row
 * also carries `id`/`workspaceId`, and callers hold refs in all of those
 * shapes. All of them name one row, so one lookup answers for all of them; a
 * ref that resolves to nothing loses the workspace's kind, role and id, and
 * the caller then treats a relay-backed session as a local one.
 */
export function projectWorkspaceForRef<
  TWorkspace extends { id?: string; workspaceId?: string; directory?: string },
>(workspaces: Record<string, TWorkspace> | undefined, ref: string | undefined): TWorkspace | undefined {
  const keyed = ref === undefined ? undefined : workspaces?.[ref]
  if (keyed) return keyed
  const workspaceId = ref?.startsWith(WORKSPACE_REF_PREFIX) ? ref.slice(WORKSPACE_REF_PREFIX.length) : undefined
  return Object.values(workspaces ?? {}).find((workspace) =>
    workspace.directory === ref ||
    workspace.id === ref ||
    workspace.workspaceId === ref ||
    (workspaceId !== undefined && (workspace.id === workspaceId || workspace.workspaceId === workspaceId))
  )
}

const WORKSPACE_REF_PREFIX = "workspace:"

function projectWorkspace(project: WorkspaceDisplayProject, directory: string) {
  return projectWorkspaceForRef(project.workspaces, directory)
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
