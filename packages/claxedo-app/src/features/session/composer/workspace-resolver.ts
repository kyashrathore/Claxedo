import {
  sameWorkspaceDirectory,
  type WorkspaceInventoryEntry,
  type WorkspaceInventoryProject,
} from "@/platform/runtime/agent/signed-workspace"
import {
  sessionRefForWorkspaceSession,
  type HarnessRef,
  type SessionRef,
  type WorkspaceSessionBacking,
} from "@/platform/identity/session-ref"
import { placementFor } from "@/platform/runtime/placement"
import { sessionSignedTransportAuthority } from "@/features/session/ui/session-identity"

export type WorkspaceCatalogKind = "local" | "cloud" | "user-hosted"
export type WorkspaceDirectory = string

const cloudWorkspaceKind = "cloud"
const localWorkspaceKind = "local"
const userHostedWorkspaceKind = "user-hosted"

export type WorkspaceCatalogEntry = WorkspaceInventoryEntry & {
  kind?: WorkspaceCatalogKind | string | null
}

export type ProjectCatalogItem = WorkspaceInventoryProject & {
  id?: string
  project_id?: string
  projectID?: string
  workspaces?: Record<string, WorkspaceCatalogEntry>
}

export type RuntimeWorkspaceRef = {
  workspaceId: string
  kind: Extract<WorkspaceCatalogKind, "cloud" | "user-hosted">
}

export type WorkspaceSubmitPlan =
  | { status: "ready"; directory: WorkspaceDirectory }
  | { status: "missing-workspace" }
  | { status: "create-local-worktree"; baseDirectory?: WorkspaceDirectory }
  | { status: "prepare-remote-workspace"; directory: WorkspaceDirectory }
  | { status: "provision-cloud-workspace"; projectId: string }

export type ResolveWorkspaceSubmitPlanInput = {
  isNewSession: boolean
  draftId?: string
  projectDirectory?: string
  fallbackDirectory?: string
  defaultDirectory: string
  worktreeSelection: string
  workspaceKind: WorkspaceCatalogKind | string
  projects: readonly ProjectCatalogItem[]
  runtimeWorkspaceRef?: (directory: WorkspaceDirectory | undefined) => RuntimeWorkspaceRef | undefined
}

export function projectId(project: ProjectCatalogItem | undefined) {
  return project?.id ?? project?.project_id ?? project?.projectID
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

export function signedWorkspaceForDirectory(input: {
  directory: WorkspaceDirectory | undefined
  projects: readonly ProjectCatalogItem[]
  sdkWorkspace?: WorkspaceCatalogEntry
}) {
  return input.sdkWorkspace ?? workspaceForDirectory(input.projects, input.directory)
}

export function knownWorkspaceKind(kind: WorkspaceCatalogEntry["kind"] | undefined): WorkspaceCatalogKind | undefined {
  if (kind === localWorkspaceKind) return localWorkspaceKind
  if (kind === cloudWorkspaceKind) return cloudWorkspaceKind
  if (kind === userHostedWorkspaceKind) return userHostedWorkspaceKind
  return undefined
}

export function composerUsesSignedTransport(input: {
  explicit?: boolean
  directory: WorkspaceDirectory
  projects: readonly ProjectCatalogItem[]
  sdkWorkspace?: WorkspaceCatalogEntry
  sessionRef?: SessionRef
  principalHasSignedAccess: boolean
  routeWorkspaceAuthorityId?: string
  serverUrl?: string
}) {
  if (input.explicit !== undefined) return input.explicit
  const workspace = signedWorkspaceForDirectory(input)
  const workspaceKind = knownWorkspaceKind(workspace?.kind)
  const placement = placementFor({
    ref: input.sessionRef,
    hasSignedAccess: sessionSignedTransportAuthority({
      serverUrl: input.serverUrl,
      principalHasSignedAccess: input.principalHasSignedAccess,
      routeWorkspaceAuthorityId: input.routeWorkspaceAuthorityId,
      workspaceKind,
      sessionRef: input.sessionRef,
    }),
    serverUrl: input.serverUrl,
    legacy: { directory: input.directory, workspaceKind },
  })
  return !!placement && placement.transport !== "loopback"
}

export function submitSessionDirectory(input: {
  directory: WorkspaceDirectory
  projects: readonly ProjectCatalogItem[]
  sdkWorkspace?: WorkspaceCatalogEntry
}) {
  const workspace = signedWorkspaceForDirectory(input)
  const workspaceId = workspace?.workspaceId ?? workspace?.id
  if (workspaceId && input.directory === workspaceId) return input.directory
  return workspace?.directory ?? input.directory
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
  if (input.directory && isRemoteWorkspaceKind(workspace?.kind)) {
    const id = workspace.id ?? workspace.workspaceId ?? undefined
    return input.runtimeWorkspaceRef?.(id) ? id : input.directory
  }
  if (input.worktreeSelection !== "main") return undefined
  return Object.entries(projectWorkspaces(input.projects, input.directory)).find(
    ([, item]) => item.kind === "cloud" && (item.workspace_name ?? item.workspaceName) === "main",
  )?.[0]
}

// `resolveWorkspaceSubmitPlan` is the pure SUB-DECISION used by the orchestrator
// `resolveSubmitDirectory` (session/submit/resolve.ts). It encodes the same
// shared top-level admission tree (see resolve.ts) and additionally resolves the
// remote branch into a concrete plan (prepare-remote / provision-cloud /
// missing-workspace) using the project catalog. The shared branches must agree
// with the orchestrator — `resolve-workspace-plan-agreement.test.ts` proves it.
export function resolveWorkspaceSubmitPlan(input: ResolveWorkspaceSubmitPlanInput): WorkspaceSubmitPlan {
  const sessionDirectory = input.projectDirectory ?? input.fallbackDirectory

  if (!input.isNewSession) {
    return { status: "ready", directory: sessionDirectory ?? input.defaultDirectory }
  }

  if (input.draftId && !input.projectDirectory && input.worktreeSelection === "main") {
    return { status: "missing-workspace" }
  }

  if (isRemoteWorkspaceKind(input.workspaceKind)) {
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
    if (isUserHostedWorkspaceKind(input.workspaceKind)) return { status: "missing-workspace" }

    const id = projectId(projectForDirectory(input.projects, selectedDirectory ?? sessionDirectory))
    if (!id) return { status: "missing-workspace" }
    return { status: "provision-cloud-workspace", projectId: id }
  }

  if (input.worktreeSelection === "create") {
    return { status: "create-local-worktree", baseDirectory: sessionDirectory }
  }

  if (input.worktreeSelection !== "main") return { status: "ready", directory: input.worktreeSelection }

  if (input.draftId && !sessionDirectory) return { status: "missing-workspace" }
  return { status: "ready", directory: sessionDirectory ?? input.defaultDirectory }
}

function workspaceBacking(
  workspace: WorkspaceCatalogEntry | undefined,
  directory: WorkspaceDirectory | undefined,
): WorkspaceSessionBacking | undefined {
  if (!isRemoteWorkspaceKind(workspace?.kind)) return undefined
  return {
    workspaceId: workspace.workspaceId ?? workspace.id ?? directory!,
    kind: workspace.kind,
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

export function isRemoteWorkspaceKind(kind: WorkspaceCatalogEntry["kind"] | ResolveWorkspaceSubmitPlanInput["workspaceKind"] | undefined) {
  return kind === cloudWorkspaceKind || kind === userHostedWorkspaceKind
}

function isUserHostedWorkspaceKind(kind: ResolveWorkspaceSubmitPlanInput["workspaceKind"]) {
  return kind === userHostedWorkspaceKind
}
