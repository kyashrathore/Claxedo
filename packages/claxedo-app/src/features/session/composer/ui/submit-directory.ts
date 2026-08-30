import { workspaceConnection } from "@/features/workspaces/data/workspace-connection"
import { isFilesystemDirectory, localWorkspaceAssociationId, workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { workspaceRouteIdentity } from "@/platform/identity/workspace-route"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { appendWorkspaceRuntimeLog } from "@/platform/runtime/workspace-log"
import { workspaceStartup } from "@/platform/runtime/workspace-startup"
import type { WorkspaceStartupPort } from "@/platform/runtime/workspace-startup-port"
import type { SubmitDirectory } from "../../submit/index"
import { resolveSubmitDirectory } from "../../submit/index"
import {
  knownWorkspaceKind,
  projectForDirectory,
  resolveWorkspaceSubmitPlan,
  type ProjectCatalogItem,
  type RuntimeWorkspaceRef,
} from "../workspace-resolver"
import type { CloudStartupState } from "./submit-create-session"

type RuntimeEvents = Parameters<WorkspaceStartupPort["prepareWorkspaceRuntime"]>[0]["events"]
type PrepareUserHostedRuntime = WorkspaceStartupPort["prepareUserHostedRuntime"]
type PrepareWorkspaceRuntime = WorkspaceStartupPort["prepareWorkspaceRuntime"]
type PrepareWorkspaceSessionWorktree = WorkspaceStartupPort["prepareWorkspaceSessionWorktree"]

export type SubmitToast = {
  readonly title: string
  readonly description?: string
}

export type SubmitDirectoryProvisionInput = {
  readonly isNewSession: boolean
  readonly draftId: string | undefined
  readonly projectDirectory: SubmitDirectory | undefined
  readonly fallbackDirectory: SubmitDirectory | undefined
  readonly defaultDirectory: SubmitDirectory
  readonly worktreeSelection: string
  readonly workspaceKind: string
  readonly projects: readonly ProjectCatalogItem[]
  readonly runtimeWorkspaceRef: (directory: SubmitDirectory | undefined) => RuntimeWorkspaceRef | undefined
  readonly workspaceForDirectory: (directory: SubmitDirectory) => { readonly kind?: string; readonly workspaceId: string } | undefined
  readonly baseUrl: string
  readonly request: typeof fetch
  readonly events: RuntimeEvents
  readonly onCloudStartup: ((state?: CloudStartupState) => void) | undefined
  readonly rememberCloudStartup: (state: Omit<CloudStartupState, "open">) => void
  readonly publishCloudHandoff: (status: string, message: string) => void
  readonly createCloudWorkspace: (projectId: string) => Promise<{ readonly workspaceId?: string } | undefined>
  readonly createLocalWorktree: (directory: SubmitDirectory) => Promise<{ readonly directory?: SubmitDirectory } | undefined>
  readonly markLocalWorktreePending: (directory: SubmitDirectory) => void
  readonly bootstrap: () => Promise<unknown> | unknown
  readonly showToast: (toast: SubmitToast) => void
  readonly errorMessage: (err: unknown) => string
  readonly text: {
    readonly worktreeCreateFailedTitle: string
    readonly missingWorkspaceTitle: string
    readonly selectProjectForWorktree: string
    readonly requestFailed: string
    readonly cloudWorkspaceCreateFailedTitle: string
    readonly attachWorkspaceBeforePrompt: string
    readonly attachProjectBeforeCloudWorkspace: string
  }
  readonly prepareUserHostedRuntime?: PrepareUserHostedRuntime
  readonly prepareWorkspaceRuntime?: PrepareWorkspaceRuntime
  readonly prepareWorkspaceSessionWorktree?: PrepareWorkspaceSessionWorktree
}

export async function resolvePreparedSubmitDirectory(input: SubmitDirectoryProvisionInput) {
  const resolved = await resolveSubmitDirectory({
    isNewSession: input.isNewSession,
    defaultDirectory: input.defaultDirectory,
    worktreeSelection: input.worktreeSelection,
    workspaceKind: input.workspaceKind,
    showMissingWorkspace: () => {
      input.showToast({
        title: input.text.missingWorkspaceTitle,
        description: input.text.attachWorkspaceBeforePrompt,
      })
    },
    resolveCloudSessionDirectory: (worktreeSelection, projectDirectory, fallbackDirectory, workspaceKind) =>
      resolveCloudSessionDirectory({
        ...input,
        worktreeSelection,
        projectDirectory,
        fallbackDirectory,
        workspaceKind,
      }),
    prepareCloudSessionDirectory: (directory) =>
      prepareRemoteSubmitDirectory({
        ...input,
        directory,
        onPublish: input.rememberCloudStartup,
      }),
    createLocalWorktree: (directory) =>
      createLocalSubmitWorktree({
        ...input,
        directory,
      }),
    publishCloudHandoff: input.publishCloudHandoff,
    ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
    ...(input.projectDirectory === undefined ? {} : { projectDirectory: input.projectDirectory }),
    ...(input.fallbackDirectory === undefined ? {} : { fallbackDirectory: input.fallbackDirectory }),
  })
  if (!resolved) return
  // Local OpenCode create needs an on-disk cwd. Opaque `/w/:uuid` route keys
  // sometimes leak in as sdk.directory before the project catalog remaps them.
  // Only refuse unresolved association UUIDs — every other opaque key keeps the
  // historical pass-through (matches origin/dev submit behavior).
  if (input.workspaceKind === "cloud" || input.workspaceKind === "user-hosted") return resolved
  if (!localWorkspaceAssociationId(resolved.directory)) return resolved
  const filesystemDirectory = workspaceRouteIdentity(input.projects, resolved.directory)?.directory
  if (filesystemDirectory && isFilesystemDirectory(filesystemDirectory)) {
    return { directory: filesystemDirectory }
  }
  input.showToast({
    title: input.text.missingWorkspaceTitle,
    description: input.text.attachWorkspaceBeforePrompt,
  })
}

async function resolveCloudSessionDirectory(input: SubmitDirectoryProvisionInput & {
  readonly worktreeSelection: string
  readonly projectDirectory: SubmitDirectory | undefined
  readonly fallbackDirectory: SubmitDirectory | undefined
  readonly workspaceKind: string
}) {
  const runtimeWorkspaceRef = (directory: SubmitDirectory | undefined): RuntimeWorkspaceRef | undefined => {
    const parsed = input.runtimeWorkspaceRef(directory)
    if (parsed || !directory) return parsed
    const workspace = input.workspaceForDirectory(directory)
    const kind = knownWorkspaceKind(workspace?.kind)
    if (!workspace || !kind || kind === "local") return
    return { workspaceId: workspace.workspaceId, kind }
  }
  const existingRemoteDirectory = existingRemoteWorkspaceDirectoryForSubmit({
    ...input,
    runtimeWorkspaceRef,
  })
  if (existingRemoteDirectory) return existingRemoteDirectory

  const plan = resolveWorkspaceSubmitPlan({
    isNewSession: true,
    defaultDirectory: input.defaultDirectory,
    worktreeSelection: input.worktreeSelection,
    workspaceKind: input.workspaceKind,
    projects: input.projects,
    runtimeWorkspaceRef,
    ...(input.projectDirectory === undefined ? {} : { projectDirectory: input.projectDirectory }),
    ...(input.fallbackDirectory === undefined ? {} : { fallbackDirectory: input.fallbackDirectory }),
  })
  if (plan.status === "prepare-remote-workspace") return plan.directory
  if (plan.status !== "provision-cloud-workspace") {
    input.showToast({
      title: input.text.cloudWorkspaceCreateFailedTitle,
      description: input.workspaceKind === "user-hosted"
        ? input.text.attachWorkspaceBeforePrompt
        : input.text.attachProjectBeforeCloudWorkspace,
    })
    return
  }

  // Track whether the create call itself rejected so we surface exactly one
  // toast per failure. Previously the .catch below toasted the error and
  // returned undefined, which then fell through into the `!workspaceId` branch
  // and toasted a *second* generic "request failed" message for the same
  // failure (see core-cloud-provisioning e2e: one toast, no pipeline/session).
  let creationRejected = false
  const createdWorkspace = await input.createCloudWorkspace(plan.projectId).catch((err) => {
    creationRejected = true
    input.showToast({
      title: input.text.cloudWorkspaceCreateFailedTitle,
      description: input.errorMessage(err),
    })
    return undefined
  })
  if (creationRejected) return
  if (!createdWorkspace?.workspaceId) {
    input.showToast({
      title: input.text.cloudWorkspaceCreateFailedTitle,
      description: input.text.requestFailed,
    })
    return
  }
  void Promise.resolve(input.bootstrap()).catch(() => undefined)
  return createdWorkspace.workspaceId
}

function existingRemoteWorkspaceDirectoryForSubmit(input: SubmitDirectoryProvisionInput & {
  readonly worktreeSelection: string
  readonly projectDirectory: SubmitDirectory | undefined
  readonly fallbackDirectory: SubmitDirectory | undefined
  readonly workspaceKind: string
  readonly runtimeWorkspaceRef: (directory: SubmitDirectory | undefined) => RuntimeWorkspaceRef | undefined
}) {
  if (input.workspaceKind !== "cloud" && input.workspaceKind !== "user-hosted") return undefined
  // Explicit "create new cloud sandbox" must provision — never reuse an existing
  // remote directory from the project catalog (see core-composer-hosted-chips e2e).
  if (input.worktreeSelection === "create") return undefined

  const remoteDirectory = (directory: SubmitDirectory | undefined) => {
    if (!directory) return undefined
    const ref = input.runtimeWorkspaceRef(directory)
    if (ref?.kind === "cloud" || ref?.kind === "user-hosted") return directory
    const workspace = input.workspaceForDirectory(directory)
    const kind = knownWorkspaceKind(workspace?.kind)
    if (workspace && (kind === "cloud" || kind === "user-hosted")) return directory
    return undefined
  }

  for (const directory of [
    input.worktreeSelection !== "main" && input.worktreeSelection !== "create" ? input.worktreeSelection : undefined,
    input.projectDirectory,
    input.fallbackDirectory,
    input.defaultDirectory,
  ]) {
    const resolved = remoteDirectory(directory)
    if (resolved) return resolved
  }

  // Only scan directories owned by the selected project — never the first remote
  // directory from an unrelated project in a multi-project catalog.
  const selectedProject =
    projectForDirectory(input.projects, input.projectDirectory)
    ?? projectForDirectory(input.projects, input.fallbackDirectory)
    ?? projectForDirectory(input.projects, input.defaultDirectory)
  if (!selectedProject) return undefined

  for (const directory of [
    selectedProject.worktree,
    ...(selectedProject.sandboxes ?? []),
    ...Object.keys(selectedProject.workspaces ?? {}),
    ...Object.values(selectedProject.workspaces ?? {})
      .map((workspace) => workspace.directory)
      .filter((directory): directory is string => typeof directory === "string" && directory.length > 0),
  ]) {
    const resolved = remoteDirectory(directory ?? undefined)
    if (resolved) return resolved
  }

  return undefined
}

async function createLocalSubmitWorktree(input: SubmitDirectoryProvisionInput & {
  readonly directory: SubmitDirectory | undefined
}) {
  const projectDirectory = projectForDirectory(input.projects, input.directory)?.worktree ?? input.directory
  if (!projectDirectory) {
    input.showToast({
      title: input.text.worktreeCreateFailedTitle,
      description: input.text.selectProjectForWorktree,
    })
    return
  }
  const createdWorktree = await input.createLocalWorktree(projectDirectory).catch((err) => {
    input.showToast({
      title: input.text.worktreeCreateFailedTitle,
      description: input.errorMessage(err),
    })
    return undefined
  })

  if (!createdWorktree?.directory) {
    input.showToast({
      title: input.text.worktreeCreateFailedTitle,
      description: input.text.requestFailed,
    })
    return
  }
  input.markLocalWorktreePending(createdWorktree.directory)
  // Worktree creation registers the directory server-side before returning.
  // Refresh that authoritative inventory before session handoff so every
  // consumer classifies the directory as the owning project's worktree.
  // Inventory display is not part of provisioning success: if the refresh is
  // temporarily unavailable, the created worktree must still receive its
  // first prompt and a later global refresh can reconcile the card.
  await Promise.resolve(input.bootstrap()).catch(() => undefined)
  return createdWorktree.directory
}

function submitRuntimeWorkspaceRef(
  input: SubmitDirectoryProvisionInput & { readonly directory: SubmitDirectory },
): RuntimeWorkspaceRef | undefined {
  return input.runtimeWorkspaceRef(input.directory)
    ?? sessionWorkspaceRuntimeRef({ directory: input.directory, projects: input.projects })
}

async function prepareRemoteSubmitDirectory(input: SubmitDirectoryProvisionInput & {
  readonly directory: SubmitDirectory
  readonly onPublish?: (state: Omit<CloudStartupState, "open">) => void
}) {
  const runtimeRef = submitRuntimeWorkspaceRef(input)
  const workspace = input.workspaceForDirectory(input.directory)
  const connectedWorkspaceId =
    runtimeRef?.workspaceId ??
    workspace?.workspaceId ??
    workspaceIdFromRef(input.directory)
  // The WorkspaceGate already drove relay-backed workspaces to `ready` before
  // the composer unlocked. Re-running provisioning on first send can treat a
  // stale resolve snapshot as not-ready and abort before POST .../session.
  if (connectedWorkspaceId && workspaceConnection(connectedWorkspaceId)?.status === "ready") {
    return true
  }

  let logs: NonNullable<CloudStartupState["logs"]> = []
  // `overlay: false` suppresses the submit-time cloud-startup overlay
  // (`onCloudStartup`) while still remembering the last state for the harness
  // handoff (`onPublish`). User-hosted workspaces own their connection UI via
  // WorkspaceGate (see resolveSubmitDirectory's comment), so surfacing the
  // overlay here would double up — and worse, strand it: the overlay's clear
  // path (`clearCloudStartup`) is gated to `workspaceKind === "cloud"` in
  // submit.ts, so an overlay opened for a user-hosted submit is NEVER closed and
  // permanently masks the session timeline once the send navigates.
  const publish = (state: Omit<CloudStartupState, "open">, opts?: { overlay?: boolean }) => {
    const next = {
      logs,
      ...state,
    }
    if (opts?.overlay !== false) {
      input.onCloudStartup?.({
        open: true,
        ...next,
      })
    }
    input.onPublish?.(next)
  }
  const userHostedWorkspace = (() => {
    const workspace = input.workspaceForDirectory(input.directory)
    return workspace?.kind === "user-hosted" ? workspace : undefined
  })()
  if (userHostedWorkspace) {
    const result = await (input.prepareUserHostedRuntime ?? workspaceStartup().prepareUserHostedRuntime)({
      workspaceId: userHostedWorkspace.workspaceId,
      directory: input.directory,
      baseUrl: input.baseUrl,
      request: input.request,
      onStatus: (status) => {
        publish({
          status,
          err: status === "error" ? input.text.requestFailed : undefined,
        }, { overlay: false })
      },
      onLog: (log) => {
        logs = appendWorkspaceRuntimeLog(logs, log.step, log.message, log.totalMs, log.ts)
        publish({
          status: log.step,
          err: log.step === "error" ? log.message : undefined,
        }, { overlay: false })
      },
    }).catch((err: unknown) => ({
      ok: false as const,
      message: err instanceof Error ? err.message : String(err),
    }))
    if (!result.ok) {
      publish({
        status: "error",
        err: ("message" in result ? result.message : undefined) ?? input.text.requestFailed,
      }, { overlay: false })
      return false
    }
    return true
  }

  const result = await (input.prepareWorkspaceRuntime ?? workspaceStartup().prepareWorkspaceRuntime)({
    directory: input.directory,
    request: input.request,
    ...(input.events === undefined ? {} : { events: input.events }),
    onResolved: (workspace) => {
      if (!workspace || workspace.kind !== "cloud" || workspace.status === "ready") return
      publish({
        id: workspace.workspaceId,
        status: workspace.status ?? "acquiring_sandbox",
        err: undefined,
      }, { overlay: false })
    },
    onStatus: (status) => {
      publish({
        status,
        err: status === "error" ? input.text.requestFailed : undefined,
      }, { overlay: false })
    },
    onLog: (log) => {
      logs = appendWorkspaceRuntimeLog(logs, log.step, log.message, log.totalMs, log.ts)
      publish({
        status: log.step,
        err: log.step === "error" ? log.message : undefined,
      }, { overlay: false })
    },
  })
  if (!result.ok) {
    publish({
      status: "error",
      err: result.message ?? input.text.requestFailed,
    }, { overlay: false })
    return false
  }
  if (input.draftId && result.workspace?.workspaceId) {
    const worktree = await (input.prepareWorkspaceSessionWorktree ?? workspaceStartup().prepareWorkspaceSessionWorktree)({
      workspaceId: result.workspace.workspaceId,
      sessionId: input.draftId,
      directory: input.directory,
      request: input.request,
    }).catch((error) => {
      publish({
        status: "error",
        err: input.errorMessage(error),
      })
      return undefined
    })
    if (!worktree) return false
    return worktree.path
  }
  return true
}
