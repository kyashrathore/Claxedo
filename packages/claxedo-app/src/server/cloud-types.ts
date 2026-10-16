import type { PlacementId, ProjectId } from "./ids"
import type { AppError, ProjectSource } from "./types"

export type CloudWorkspaceStatus =
  | { readonly kind: "provisioning"; readonly step: string }
  | { readonly kind: "starting" }
  | { readonly kind: "ready" }
  | { readonly kind: "stopping" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly reason: string; readonly checkpointUnusable?: true }

export type CloudWorkspace = {
  readonly id: PlacementId
  readonly projectId: ProjectId
  readonly name?: string
  readonly branch?: string
  readonly status: CloudWorkspaceStatus
}

export type WorkspaceBootMode = "restore" | "resume" | "cold-start"

export type WorkspaceStartStep = "machine" | "image" | "runtime"

export type WorkspaceStartSteps = { readonly done: readonly WorkspaceStartStep[]; readonly startedAt: number; readonly stepStartedAt: number }

export type WorkspaceStartProgress = { readonly kind: "provisioning"; readonly bootMode?: WorkspaceBootMode; readonly failure?: string; readonly retryAt?: number; readonly steps?: WorkspaceStartSteps }

export type WorkspaceRuntime =
  | { readonly kind: "live" }
  | { readonly kind: "asleep" }
  | { readonly kind: "waking"; readonly bootMode?: WorkspaceBootMode; readonly failure?: string; readonly retryAt?: number; readonly steps?: WorkspaceStartSteps; readonly followed?: true }
  | { readonly kind: "wakeFailed"; readonly error: AppError; readonly retryAt?: number; readonly checkpointUnusable?: true }
  | { readonly kind: "outdated" }

export type MachineClass = "small" | "default" | "large"

export type CloudProjectCreateInput = {
  readonly projectId: ProjectId
  readonly name: string
  readonly branch?: string
  readonly machineClass?: MachineClass
}

export type CloudSourceCreateInput = {
  readonly source: Exclude<ProjectSource, { readonly kind: "folder" }>
  readonly name: string
  readonly machineClass?: MachineClass
  readonly onCreated?: (id: PlacementId) => void
}

export type CloudCreateInput = CloudProjectCreateInput | CloudSourceCreateInput

export type CodeHostConnection = {
  readonly id: string
  readonly providerName: string
  readonly accountLabel?: string
  readonly status: "connected" | "degraded" | "broken"
}

export type CodeHostRepository = { readonly id: string; readonly fullName: string; readonly private: boolean }

export type CodeHostAppInstallation = {
  readonly account: string
  readonly settingsUrl: string
  readonly repositorySelection: "all" | "selected"
}

export type CodeHostRepositoryAccess =
  | { readonly kind: "app"; readonly installations: readonly CodeHostAppInstallation[] }
  | { readonly kind: "token"; readonly settingsUrl: string }

export type CodeHostRepositoryListing = {
  readonly repositories: readonly CodeHostRepository[]
  readonly access?: CodeHostRepositoryAccess
}
