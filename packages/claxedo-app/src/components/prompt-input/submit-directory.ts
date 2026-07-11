import {
  appendWorkspaceRuntimeLog,
  prepareUserHostedRuntime,
  prepareWorkspaceRuntime,
} from "../../cloud/workspace-runtime-store"
import type { SubmitDirectory } from "../../session/submit"
import { resolveSubmitDirectory } from "../../session/submit"
import {
  projectForDirectory,
  resolveWorkspaceSubmitPlan,
  type ProjectCatalogItem,
  type RuntimeWorkspaceRef,
} from "../../session-client/composer/workspace-resolver"
import type { CloudStartupState } from "./submit-create-session"

type RuntimeEvents = Parameters<typeof prepareWorkspaceRuntime>[0]["events"]
type PrepareUserHostedRuntime = typeof prepareUserHostedRuntime
type PrepareWorkspaceRuntime = typeof prepareWorkspaceRuntime

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
}

export async function resolvePreparedSubmitDirectory(input: SubmitDirectoryProvisionInput) {
  return await resolveSubmitDirectory({
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
}

async function resolveCloudSessionDirectory(input: SubmitDirectoryProvisionInput & {
  readonly worktreeSelection: string
  readonly projectDirectory: SubmitDirectory | undefined
  readonly fallbackDirectory: SubmitDirectory | undefined
  readonly workspaceKind: string
}) {
  const plan = resolveWorkspaceSubmitPlan({
    isNewSession: true,
    defaultDirectory: input.defaultDirectory,
    worktreeSelection: input.worktreeSelection,
    workspaceKind: input.workspaceKind,
    projects: input.projects,
    runtimeWorkspaceRef: input.runtimeWorkspaceRef,
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
  return createdWorktree.directory
}

async function prepareRemoteSubmitDirectory(input: SubmitDirectoryProvisionInput & {
  readonly directory: SubmitDirectory
  readonly onPublish?: (state: Omit<CloudStartupState, "open">) => void
}) {
  let logs: NonNullable<CloudStartupState["logs"]> = []
  const publish = (state: Omit<CloudStartupState, "open">) => {
    const next = {
      logs,
      ...state,
    }
    input.onCloudStartup?.({
      open: true,
      ...next,
    })
    input.onPublish?.(next)
  }
  const userHostedWorkspace = (() => {
    const workspace = input.workspaceForDirectory(input.directory)
    return workspace?.kind === "user-hosted" ? workspace : undefined
  })()
  if (userHostedWorkspace) {
    const result = await (input.prepareUserHostedRuntime ?? prepareUserHostedRuntime)({
      workspaceId: userHostedWorkspace.workspaceId,
      directory: input.directory,
      request: input.request,
      onStatus: (status) => {
        publish({
          status,
          err: status === "error" ? input.text.requestFailed : undefined,
        })
      },
      onLog: (log) => {
        logs = appendWorkspaceRuntimeLog(logs, log.step, log.message, log.totalMs, log.ts)
        publish({
          status: log.step,
          err: log.step === "error" ? log.message : undefined,
        })
      },
    }).catch((err: unknown) => ({
      ok: false as const,
      message: err instanceof Error ? err.message : String(err),
    }))
    if (!result.ok) {
      publish({
        status: "error",
        err: ("message" in result ? result.message : undefined) ?? input.text.requestFailed,
      })
      return false
    }
    return true
  }

  const result = await (input.prepareWorkspaceRuntime ?? prepareWorkspaceRuntime)({
    directory: input.directory,
    request: input.request,
    ...(input.events === undefined ? {} : { events: input.events }),
    onResolved: (workspace) => {
      if (!workspace || workspace.kind !== "cloud" || workspace.status === "ready") return
      publish({
        id: workspace.workspaceId,
        status: workspace.status ?? "acquiring_sandbox",
        err: undefined,
      })
    },
    onStatus: (status) => {
      publish({
        status,
        err: status === "error" ? input.text.requestFailed : undefined,
      })
    },
    onLog: (log) => {
      logs = appendWorkspaceRuntimeLog(logs, log.step, log.message, log.totalMs, log.ts)
      publish({
        status: log.step,
        err: log.step === "error" ? log.message : undefined,
      })
    },
  })
  if (!result.ok) {
    publish({
      status: "error",
      err: result.message ?? input.text.requestFailed,
    })
    return false
  }
  return true
}
