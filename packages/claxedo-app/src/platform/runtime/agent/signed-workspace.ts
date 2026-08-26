import type { SignedWorkspaceKind } from "./workspace-kind"
export type { SignedWorkspaceKind }

export type SignedWorkspaceInfo = {
  workspaceId: string
  directory?: string
  workspaceName?: string
  kind: SignedWorkspaceKind
}

type WorkspaceProject = {
  worktree?: string
  sandboxes?: string[]
  workspaces?: Record<
    string,
    {
      id?: string
      workspaceId?: string
      kind?: string
      directory?: string
      workspace_name?: string
      workspaceName?: string
    }
  >
}

const signedWorkspaceCache = new WeakMap<readonly WorkspaceProject[], Map<string, SignedWorkspaceInfo | null>>()

function workspaceDirectoryAliasKey(input: string | undefined) {
  if (!input) return ""
  // macOS resolves /tmp, /var, /etc to /private/* symlinks, so the directory a
  // runtime reports (/tmp/...) and the one the browser sees (/private/tmp/...)
  // differ for the same worktree. Normalise the /private prefix so they match.
  return input.startsWith("/private/") ? input.slice("/private".length) : input
}

export function sameWorkspaceDirectory(left: string | undefined, right: string | undefined) {
  return !!left && !!right && workspaceDirectoryAliasKey(left) === workspaceDirectoryAliasKey(right)
}

function sameWorkspaceId(left: string | undefined, right: string | undefined) {
  return !!left && !!right && left === right
}

export function signedWorkspaceFromProjects(projects: readonly WorkspaceProject[], directory: string | undefined) {
  if (!directory) return undefined
  const cached = signedWorkspaceCache.get(projects)?.get(directory)
  if (cached !== undefined) return cached ?? undefined
  const workspace = findSignedWorkspaceFromProjects(projects, directory)
  const projectCache = signedWorkspaceCache.get(projects) ?? new Map<string, SignedWorkspaceInfo | null>()
  projectCache.set(directory, workspace ?? null)
  signedWorkspaceCache.set(projects, projectCache)
  return workspace
}

function findSignedWorkspaceFromProjects(projects: readonly WorkspaceProject[], directory: string) {
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
      )
        continue
      return {
        workspaceId,
        directory: workspace.directory ?? directory,
        workspaceName: workspace.workspace_name ?? workspace.workspaceName,
        kind,
      } satisfies SignedWorkspaceInfo
    }
  }
  return undefined
}
