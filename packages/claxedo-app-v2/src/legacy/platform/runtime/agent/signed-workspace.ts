import {
  isRelayHostKind,
  rowHostKind,
  type RelayHostKind,
  type WorkspaceHost,
} from "@/platform/runtime/placement-wire"
import { isFilesystemDirectory, sameWorkspaceDirectory } from "@/platform/identity/legacy-resolver"

export type SignedWorkspaceInfo = {
  workspaceId: string
  directory?: string
  workspaceName?: string
  kind: RelayHostKind
  /**
   * The host, as a CONTROL-PLANE row states it. Absent when the row that
   * matched states no placement — a shell or bootstrap project row — which is
   * "not stated", never "no host".
   */
  host?: WorkspaceHost
}

export type WorkspaceInventoryEntry = {
  id?: string | null
  workspaceId?: string | null
  /**
   * Where the row's producer says the workspace runs. The two words are two
   * producers, not a choice: the daemon's store writes `kind`, the signed
   * bootstrap and the hosted shell write `backing`. Read either through
   * `rowHostKind`, never here.
   */
  kind?: string | null
  backing?: string | null
  placement?: { host_enrollment_id?: string | null } | null
  /**
   * Wire field: the serving process's own declaration of how the runtime
   * behind this workspace composed session access. Read it through
   * `declaredSessionAuthority`, which narrows an unknown value to "not
   * declared" rather than defaulting.
   */
  session_authority?: string | null
  directory?: string | null
  workspace_name?: string | null
  workspaceName?: string | null
}

export type WorkspaceInventoryProject = {
  /** Desktop local projects route by this UUID; see `localWorkspaceInProjects`. */
  id?: string | null
  worktree?: string
  sandboxes?: string[]
  workspaces?: Record<string, WorkspaceInventoryEntry>
}

const signedWorkspaceCache = new WeakMap<readonly WorkspaceInventoryProject[], Map<string, SignedWorkspaceInfo | null>>()

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
      if (rowHostKind(workspace) !== "self") continue
      if (
        !sameWorkspaceId(key, ref) &&
        !sameWorkspaceId(workspace.id, ref) &&
        !sameWorkspaceId(workspace.workspaceId, ref) &&
        !sameWorkspaceDirectory(key, ref) &&
        !sameWorkspaceDirectory(workspace.directory, ref)
      ) continue
      return true
    }
    // Desktop local projects use the project UUID as the workspace route id.
    // That UUID is not relay-backed unless a signed relay-placed row also
    // claims it — routing it at the control plane mints 403 `workspace_authorization_denied`.
    if (
      isFilesystemDirectory(project.worktree ?? undefined) &&
      (sameWorkspaceId(project.id, ref) || sameWorkspaceDirectory(project.worktree, ref)) &&
      !findSignedWorkspaceFromProjects(projects, ref)
    ) {
      return true
    }
  }
  return false
}

/**
 * The host a raw inventory/session row places its workspace on, when that host
 * is not the attached server itself.
 *
 * `undefined` covers both "this server serves it" and "the row says nothing" —
 * every caller treats both as "no relay to reach".
 */
export function workspaceHostingKind(input: unknown): RelayHostKind | undefined {
  const kind = rowHostKind(input)
  return isRelayHostKind(kind) ? kind : undefined
}

function statedHost(kind: RelayHostKind, placement: { host_enrollment_id?: string | null }): WorkspaceHost {
  if (kind === "provisioner") return { kind }
  const enrollmentId = placement.host_enrollment_id
  return { kind, ...(enrollmentId ? { enrollmentId } : {}) }
}

function findSignedWorkspaceFromProjects(projects: readonly WorkspaceInventoryProject[], directory: string) {
  for (const project of projects) {
    for (const [key, workspace] of Object.entries(project.workspaces ?? {})) {
      const kind = rowHostKind(workspace)
      if (!isRelayHostKind(kind)) continue
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
        ...(workspace.placement ? { host: statedHost(kind, workspace.placement) } : {}),
      } satisfies SignedWorkspaceInfo
    }
  }
  return undefined
}
