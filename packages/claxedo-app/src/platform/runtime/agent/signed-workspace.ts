import type { SignedWorkspaceKind } from "./workspace-kind"
export type { SignedWorkspaceKind }

export type SignedWorkspaceInfo = {
  workspaceId: string
  directory?: string
  workspaceName?: string
  kind: SignedWorkspaceKind
}

export type WorkspaceInventoryEntry = {
  id?: string | null
  workspaceId?: string | null
  kind?: string | null
  directory?: string | null
  workspace_name?: string | null
  workspaceName?: string | null
}

export type WorkspaceInventoryProject = {
  worktree?: string
  sandboxes?: string[]
  workspaces?: Record<string, WorkspaceInventoryEntry>
}

const signedWorkspaceCache = new WeakMap<readonly WorkspaceInventoryProject[], Map<string, SignedWorkspaceInfo | null>>()

function workspaceDirectoryAliasKey(input: string | undefined) {
  if (!input) return ""
  // macOS resolves /tmp, /var, /etc to /private/* symlinks, so the directory a
  // runtime reports (/tmp/...) and the one the browser sees (/private/tmp/...)
  // differ for the same worktree. Normalise the /private prefix so they match.
  return input.startsWith("/private/") ? input.slice("/private".length) : input
}

export function sameWorkspaceDirectory(left: string | null | undefined, right: string | null | undefined) {
  return !!left && !!right && workspaceDirectoryAliasKey(left) === workspaceDirectoryAliasKey(right)
}

function sameWorkspaceId(left: string | null | undefined, right: string | null | undefined) {
  return !!left && !!right && left === right
}

export function signedWorkspaceFromProjects(projects: readonly WorkspaceInventoryProject[], directory: string | undefined) {
  if (!directory) return undefined
  const cached = signedWorkspaceCache.get(projects)?.get(directory)
  if (cached !== undefined) return cached ?? undefined
  const workspace = findSignedWorkspaceFromProjects(projects, directory)
  const projectCache = signedWorkspaceCache.get(projects) ?? new Map<string, SignedWorkspaceInfo | null>()
  projectCache.set(directory, workspace ?? null)
  signedWorkspaceCache.set(projects, projectCache)
  return workspace
}

/**
 * Whether the project inventory POSITIVELY identifies `ref` — a workspace id or
 * a directory — as a LOCAL workspace.
 *
 * `signedWorkspaceFromProjects` answers "is this relay-backed?" and returns
 * `undefined` for two very different situations: a workspace the inventory
 * knows is local, and one it has never heard of. Callers that fall back to
 * relay routing on `undefined` need to tell those apart. An unknown ref may
 * still turn out to be a cloud workspace whose inventory has not loaded yet, so
 * the optimistic fallback is right there; a known-local workspace has no relay
 * to reach and never will, so routing it at one is a request that can only fail.
 */
export function localWorkspaceInProjects(projects: readonly WorkspaceInventoryProject[], ref: string | undefined) {
  if (!ref) return false
  for (const project of projects) {
    for (const [key, workspace] of Object.entries(project.workspaces ?? {})) {
      if (workspace.kind !== "local") continue
      if (
        !sameWorkspaceId(key, ref) &&
        !sameWorkspaceId(workspace.id, ref) &&
        !sameWorkspaceId(workspace.workspaceId, ref) &&
        !sameWorkspaceDirectory(key, ref) &&
        !sameWorkspaceDirectory(workspace.directory, ref)
      ) continue
      return true
    }
  }
  return false
}

function findSignedWorkspaceFromProjects(projects: readonly WorkspaceInventoryProject[], directory: string) {
  for (const project of projects) {
    for (const [key, workspace] of Object.entries(project.workspaces ?? {})) {
      const kind = workspace.kind
      if (kind !== "cloud" && kind !== "user-hosted") continue
      const workspaceId = workspace.workspaceId ?? workspace.id ?? key
      if (!workspaceId) continue
      if (
        !sameWorkspaceId(key, directory) &&
        !sameWorkspaceId(workspace.id, directory) &&
        !sameWorkspaceId(workspace.workspaceId, directory) &&
        !sameWorkspaceDirectory(key, directory) &&
        !sameWorkspaceDirectory(workspace.directory, directory)
      ) continue
      return {
        workspaceId,
        directory: workspace.directory ?? directory,
        ...(workspace.workspace_name ?? workspace.workspaceName
          ? { workspaceName: workspace.workspace_name ?? workspace.workspaceName ?? undefined }
          : {}),
        kind,
      } satisfies SignedWorkspaceInfo
    }
  }
  return undefined
}
