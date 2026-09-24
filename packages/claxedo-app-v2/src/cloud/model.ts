import { unreachable } from "@/lib/machine"
import type { PlacementId, ProjectId } from "@/server"

export type CloudWorkspaceState =
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
  readonly status: CloudWorkspaceState
}

export type CloudWorkspaceEvent =
  | { readonly type: "startRequested" }
  | { readonly type: "stopRequested" }
  | { readonly type: "commandFailed"; readonly reason: string }

export function canStart(state: CloudWorkspaceState): boolean {
  return state.kind === "stopped" || state.kind === "failed"
}

export function canStop(state: CloudWorkspaceState): boolean {
  return state.kind === "ready" || state.kind === "starting" || state.kind === "provisioning"
}

export function isBusy(state: CloudWorkspaceState): boolean {
  return state.kind === "provisioning" || state.kind === "starting" || state.kind === "stopping"
}

export function failureOf(state: CloudWorkspaceState): string | undefined {
  return state.kind === "failed" ? state.reason : undefined
}

export function cloudWorkspaceTransition(state: CloudWorkspaceState, event: CloudWorkspaceEvent): CloudWorkspaceState {
  switch (event.type) {
    case "startRequested":
      return canStart(state) ? { kind: "starting" } : state
    case "stopRequested":
      return canStop(state) ? { kind: "stopping" } : state
    case "commandFailed":
      return { kind: "failed", reason: event.reason }
    default:
      return unreachable(event)
  }
}
