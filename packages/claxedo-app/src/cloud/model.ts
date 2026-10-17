import { unreachable } from "@/lib/machine"
import type { CloudWorkspaceStatus } from "@/server"

export type CloudWorkspaceEvent = { readonly type: "startRequested" } | { readonly type: "startFreshRequested" } | { readonly type: "stopRequested" }

export type CloudCommand = "start" | "startFresh" | "stop" | "remove"

export type CloudCommandFailure = { readonly command: CloudCommand; readonly reason: string }

export function canStartFresh(state: CloudWorkspaceStatus): boolean {
  return state.kind === "failed" && state.checkpointUnusable === true
}

export function canStart(state: CloudWorkspaceStatus): boolean {
  return state.kind === "stopped" || (state.kind === "failed" && !canStartFresh(state))
}

export function canStop(state: CloudWorkspaceStatus): boolean {
  return state.kind === "ready" || state.kind === "starting" || state.kind === "provisioning"
}

export function isRunning(state: CloudWorkspaceStatus): boolean {
  return state.kind !== "stopped" && state.kind !== "failed"
}

export function cloudStatusReason(state: CloudWorkspaceStatus): string | undefined {
  return state.kind === "failed" || state.kind === "stopped" ? state.reason : undefined
}

export function cloudWorkspaceTransition(state: CloudWorkspaceStatus, event: CloudWorkspaceEvent): CloudWorkspaceStatus {
  switch (event.type) {
    case "startRequested":
      return canStart(state) ? { kind: "starting" } : state
    case "startFreshRequested":
      return canStartFresh(state) ? { kind: "starting" } : state
    case "stopRequested":
      return canStop(state) ? { kind: "stopping" } : state
    default:
      return unreachable(event)
  }
}
