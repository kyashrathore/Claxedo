import { type SignedWorkspaceInfo, type WorkspaceInventoryEntry, type WorkspaceInventoryProject } from "@/platform/runtime/agent/signed-workspace"
import { sameWorkspaceDirectory } from "@/platform/identity/legacy-resolver"
import {
  sessionRefForWorkspaceSession,
  type HarnessRef,
  type SessionRef,
  type WorkspaceSessionBacking,
} from "@/platform/identity/session-ref"
import { placementFor } from "@/platform/runtime/placement"
import { inventoryHostKind, isRelayHostKind, type RelayHostKind, type WorkspaceHostKind } from "@/platform/runtime/placement-wire"
import { sessionSignedTransportAuthority } from "@/features/session/ui/session-identity"
import { resolveWorkspaceSubmitSelection, type WorkspaceSubmitSelection, type WorkspaceSubmitSelectionInput } from "./workspace-submit-selection"

export type WorkspaceDirectory = string

export type WorkspaceCatalogEntry = WorkspaceInventoryEntry & {
  // Wire field: the catalog may name a kind this build does not know, so it is
  // a free string here. `inventoryHostKind` is the narrower to a host kind.
  kind?: string | null
  id?: string | null
  workspaceId?: string | null
  directory?: string | null
  workspace_name?: string | null
  workspaceName?: string | null
  repo_url?: string | null
  repoUrl?: string | null
  git_remote?: string | null
  gitRemote?: string | null
}

export type ProjectCatalogItem = WorkspaceInventoryProject & {
  id?: string
  project_id?: string
  projectID?: string
  workspaces?: Record<string, WorkspaceCatalogEntry>
}

export type RuntimeWorkspaceRef = {
  workspaceId: string
  kind: RelayHostKind
}

export function selectedNewSessionWorkspace(input: {
  newSession: boolean
  kind?: WorkspaceHostKind
  worktree?: string
}): ({ kind: RelayHostKind; workspaceId?: string }) | undefined {
  if (!input.newSession || !isRelayHostKind(input.kind)) return undefined
  const workspaceId = input.worktree
  return {
    kind: input.kind,
    ...(workspaceId && workspaceId !== "main" && workspaceId !== "create" ? { workspaceId } : {}),
  }
}

export type WorkspaceSubmitPlan =
  | Exclude<WorkspaceSubmitSelection, { status: "resolve-remote-workspace" }>
  | { status: "prepare-remote-workspace"; directory: WorkspaceDirectory }
  | { status: "provision-cloud-workspace"; projectId: string }

export type ResolveWorkspaceSubmitPlanInput = WorkspaceSubmitSelectionInput & {
  projects: readonly ProjectCatalogItem[]
  runtimeWorkspaceRef?: (directory: WorkspaceDirectory | undefined) => RuntimeWorkspaceRef | undefined
}

export function projectId(project: ProjectCatalogItem | undefined) {
  return project?.id ?? project?.project_id ?? project?.projectID
}

/**
 * The cloud-create payload for one project, read from the catalog.
 *
 * Lives beside the other catalog readers rather than in the composer: which
 * fields a create carries is a question about the project inventory, and the
 * composer should not have to know that a repo URL is discovered per workspace.
 */
export function cloudWorkspaceCreateInput(
  projects: readonly ProjectCatalogItem[],
  id: string,
  gitBranch?: string,
) {
  const project = projects.find((item) => projectId(item) === id)
  const repoUrl = projectRepoUrl(project)
  return {
    projectId: id,
    ...(repoUrl ? { repoUrl } : {}),
    ...(gitBranch ? { gitBranch } : {}),
  }
}

/** Repository source already discovered by the authoritative project inventory. */
export function projectRepoUrl(project: ProjectCatalogItem | undefined) {
  if (!project) return undefined
  for (const workspace of Object.values(project.workspaces ?? {})) {
    const remote = workspace.repo_url ?? workspace.repoUrl ?? workspace.git_remote ?? workspace.gitRemote
    if (typeof remote === "string" && remote.trim()) return remote.trim()
  }
  return undefined
}

export function projectForDirectory(projects: readonly ProjectCatalogItem[], directory: WorkspaceDirectory | undefined) {
  if (!directory) return undefined
  return projects.find((project) => {
    const workspaces = project.workspaces ?? {}
    return sameWorkspaceDirectory(project.worktree, directory) ||
      project.sandboxes?.some((sandbox) => sameWorkspaceDirectory(sandbox, directory)) ||
      Object.entries(workspaces).some(([key, workspace]) => workspaceMatchesDirectory(key, workspace, directory))
  })
}

export function projectWorkspaces(projects: readonly ProjectCatalogItem[], directory: WorkspaceDirectory | undefined) {
  return projectForDirectory(projects, directory)?.workspaces ?? {}
}

export function workspaceForDirectory(projects: readonly ProjectCatalogItem[], directory: WorkspaceDirectory | undefined) {
  if (!directory) return undefined
  const workspaces = projectWorkspaces(projects, directory)
  return Object.entries(workspaces).find(([key, workspace]) => workspaceMatchesDirectory(key, workspace, directory))?.[1]
}

/**
 * The host a directory's workspace runs on, from whichever source states it.
 *
 * The sdk's workspace already speaks host kinds; a catalog row carries the
 * control plane's wire word. Reading both through one name is how a branch
 * goes dead with nothing to see at the call site, so each source is narrowed
 * by its own reader and the sdk's answer wins where it has one.
 */
export function signedWorkspaceHostKind(input: {
  directory: WorkspaceDirectory | undefined
  projects: readonly ProjectCatalogItem[]
  sdkWorkspace?: SignedWorkspaceInfo
}): WorkspaceHostKind | undefined {
  if (input.sdkWorkspace) return input.sdkWorkspace.kind
  return inventoryHostKind(workspaceForDirectory(input.projects, input.directory)?.kind)
}

/**
 * The session composition a catalog row DECLARES, or `undefined` when it
 * declares none.
 *
 * The one reader of the catalog's `session_authority`. It narrows rather than
 * defaults on purpose: "this server said nothing" is a different answer from
 * "this server said local", and only the first may be filled in by whatever
 * else the caller knows about the workspace.
 */
export function declaredSessionAuthority(
  workspace: WorkspaceCatalogEntry | undefined,
): "local" | "managed-private" | undefined {
  const declared = workspace?.session_authority
  return declared === "local" || declared === "managed-private" ? declared : undefined
}

export function composerUsesSignedTransport(input: {
  explicit?: boolean
  directory: WorkspaceDirectory
  projects: readonly ProjectCatalogItem[]
  sdkWorkspace?: SignedWorkspaceInfo
  sessionRef?: SessionRef
  principalHasSignedAccess: boolean
  routeWorkspaceAuthorityId?: string
  serverUrl?: string
}) {
  if (input.explicit !== undefined) return input.explicit
  const hostKind = signedWorkspaceHostKind(input)
  const placement = placementFor({
    ref: input.sessionRef,
    hasSignedAccess: sessionSignedTransportAuthority({
      serverUrl: input.serverUrl,
      principalHasSignedAccess: input.principalHasSignedAccess,
      routeWorkspaceAuthorityId: input.routeWorkspaceAuthorityId,
      hostKind,
      sessionRef: input.sessionRef,
    }),
    serverUrl: input.serverUrl,
    legacy: { directory: input.directory, hostKind },
  })
  return !!placement && placement.transport !== "loopback"
}

export function submitSessionDirectory(input: {
  directory: WorkspaceDirectory
  projects: readonly ProjectCatalogItem[]
  sdkWorkspace?: SignedWorkspaceInfo
}) {
  const row = input.sdkWorkspace ? undefined : workspaceForDirectory(input.projects, input.directory)
  const workspaceId = input.sdkWorkspace?.workspaceId ?? row?.workspaceId ?? row?.id
  if (workspaceId && input.directory === workspaceId) return input.directory
  return input.sdkWorkspace?.directory ?? row?.directory ?? input.directory
}

export function sessionRefForSubmitTarget(input: {
  sessionId: string
  directory: WorkspaceDirectory | undefined
  projects: readonly ProjectCatalogItem[]
  runtimeWorkspaceRef?: RuntimeWorkspaceRef
  harness?: HarnessRef
}): SessionRef | undefined {
  if (input.runtimeWorkspaceRef) {
    return sessionRefForWorkspaceSession({
      sessionId: input.sessionId,
      workspace: input.runtimeWorkspaceRef,
      harness: input.harness,
    })
  }

  const workspace = workspaceForDirectory(input.projects, input.directory)
  const backing = workspaceBacking(workspace, input.directory)
  if (backing) {
    return sessionRefForWorkspaceSession({
      sessionId: input.sessionId,
      directory: input.directory,
      workspace: backing,
      harness: input.harness,
    })
  }

  return sessionRefForWorkspaceSession({
    sessionId: input.sessionId,
    directory: input.directory,
    harness: input.harness,
  })
}

export function selectedWorktreeDirectory(input: {
  worktreeSelection: string
  projectDirectory?: string
  fallbackDirectory?: string
  projects: readonly ProjectCatalogItem[]
}) {
  if (input.worktreeSelection === "create") return undefined
  if (input.worktreeSelection === "main") {
    return projectForDirectory(input.projects, input.projectDirectory ?? input.fallbackDirectory)?.worktree ??
      input.projectDirectory ??
      input.fallbackDirectory
  }
  return input.worktreeSelection
}

export function existingRemoteWorkspaceDirectory(input: {
  worktreeSelection: string
  directory: WorkspaceDirectory | undefined
  projects: readonly ProjectCatalogItem[]
  runtimeWorkspaceRef?: (directory: WorkspaceDirectory | undefined) => RuntimeWorkspaceRef | undefined
}) {
  if (input.runtimeWorkspaceRef?.(input.directory)) return input.directory
  const workspace = workspaceForDirectory(input.projects, input.directory)
  if (input.directory && workspace && isRelayHostKind(inventoryHostKind(workspace.kind))) {
    const id = workspace.id ?? workspace.workspaceId ?? undefined
    return input.runtimeWorkspaceRef?.(id) ? id : input.directory
  }
  if (input.worktreeSelection !== "main") return undefined
  return Object.entries(projectWorkspaces(input.projects, input.directory)).find(
    ([, item]) => inventoryHostKind(item.kind) === "provisioner" && (item.workspace_name ?? item.workspaceName) === "main",
  )?.[0]
}

/** Resolve remote selections through the project catalog after the shared admission policy. */
export function resolveWorkspaceSubmitPlan(input: ResolveWorkspaceSubmitPlanInput): WorkspaceSubmitPlan {
  const selection = resolveWorkspaceSubmitSelection(input)
  if (selection.status !== "resolve-remote-workspace") return selection

  const sessionDirectory = input.projectDirectory ?? input.fallbackDirectory
  const selectedDirectory = input.worktreeSelection === "main" && input.runtimeWorkspaceRef?.(input.projectDirectory)
    ? input.projectDirectory
    : selectedWorktreeDirectory({
        worktreeSelection: input.worktreeSelection,
        projectDirectory: input.projectDirectory,
        fallbackDirectory: input.fallbackDirectory,
        projects: input.projects,
      })
  const existingDirectory = existingRemoteWorkspaceDirectory({
    worktreeSelection: input.worktreeSelection,
    directory: selectedDirectory,
    projects: input.projects,
    runtimeWorkspaceRef: input.runtimeWorkspaceRef,
  })
  if (existingDirectory) return { status: "prepare-remote-workspace", directory: existingDirectory }
  if (input.hostKind === "machine") return { status: "missing-workspace" }

  const id = projectId(projectForDirectory(input.projects, selectedDirectory ?? sessionDirectory))
  if (!id) return { status: "missing-workspace" }
  return { status: "provision-cloud-workspace", projectId: id }
}

function workspaceBacking(
  workspace: WorkspaceCatalogEntry | undefined,
  directory: WorkspaceDirectory | undefined,
): WorkspaceSessionBacking | undefined {
  const kind = inventoryHostKind(workspace?.kind)
  if (!workspace || !isRelayHostKind(kind)) return undefined
  return {
    workspaceId: workspace.workspaceId ?? workspace.id ?? directory!,
    kind,
  }
}

function workspaceMatchesDirectory(key: string, workspace: WorkspaceCatalogEntry, directory: WorkspaceDirectory) {
  return sameWorkspaceId(key, directory) ||
    sameWorkspaceId(workspace.id ?? undefined, directory) ||
    sameWorkspaceId(workspace.workspaceId ?? undefined, directory) ||
    sameWorkspaceDirectory(key, directory) ||
    sameWorkspaceDirectory(workspace.directory ?? undefined, directory)
}

function sameWorkspaceId(left: string | undefined, right: string | undefined) {
  return !!left && !!right && left === right
}



