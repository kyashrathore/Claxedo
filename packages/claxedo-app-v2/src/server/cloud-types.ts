import type { PlacementId, ProjectId } from "./ids"

export type CloudWorkspaceStatus =
  | { readonly kind: "provisioning"; readonly step: string }
  | { readonly kind: "starting" }
  | { readonly kind: "ready" }
  | { readonly kind: "stopping" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly reason: string }

export type CloudWorkspace = {
  readonly id: PlacementId
  readonly projectId: ProjectId
  readonly name: string
  readonly branch?: string
  readonly status: CloudWorkspaceStatus
}

export type CloudCreateInput = {
  readonly projectId: ProjectId
  readonly name?: string
  readonly branch?: string
}

export type CodeHostConnection = {
  readonly id: string
  readonly providerName: string
  readonly accountLabel?: string
  readonly status: "connected" | "degraded" | "broken"
}

export type CodeHostRepository = { readonly id: string; readonly fullName: string; readonly private: boolean }
