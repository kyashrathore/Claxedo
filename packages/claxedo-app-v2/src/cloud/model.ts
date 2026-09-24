import { unreachable } from "@/lib/machine"
import type { PlacementId, ProjectId } from "@/server"

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

export type CloudWorkspaceState = CloudWorkspaceStatus

export type CloudWorkspaceEvent =
  | { readonly type: "statusReported"; readonly status: CloudWorkspaceStatus }
  | { readonly type: "startRequested" }
  | { readonly type: "stopRequested" }
  | { readonly type: "commandFailed"; readonly reason: string }

export function cloudWorkspaceTransition(state: CloudWorkspaceState, event: CloudWorkspaceEvent): CloudWorkspaceState {
  switch (event.type) {
    case "statusReported":
      return event.status
    case "startRequested":
      return state.kind === "stopped" || state.kind === "failed" ? { kind: "starting" } : state
    case "stopRequested":
      return state.kind === "ready" || state.kind === "starting" || state.kind === "provisioning" ? { kind: "stopping" } : state
    case "commandFailed":
      return { kind: "failed", reason: event.reason }
    default:
      return unreachable(event)
  }
}

export function canStart(state: CloudWorkspaceState): boolean {
  return state.kind === "stopped" || state.kind === "failed"
}

export function canStop(state: CloudWorkspaceState): boolean {
  return state.kind === "ready" || state.kind === "starting" || state.kind === "provisioning"
}

export function isBusy(state: CloudWorkspaceState): boolean {
  return state.kind === "provisioning" || state.kind === "starting" || state.kind === "stopping"
}
