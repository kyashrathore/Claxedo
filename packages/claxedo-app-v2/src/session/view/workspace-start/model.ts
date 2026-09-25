import { unreachable } from "@/lib/machine"
import type { AppError, WorkspaceBootMode } from "@/server"

export type WorkspaceStartState =
  | { readonly kind: "stopped" }
  | { readonly kind: "starting"; readonly bootMode?: WorkspaceBootMode }
  | { readonly kind: "failed"; readonly error: AppError }

export type WorkspaceStartEvent =
  | { readonly type: "startRequested" }
  | { readonly type: "provisioning"; readonly bootMode?: WorkspaceBootMode }
  | { readonly type: "started" }
  | { readonly type: "startFailed"; readonly error: AppError }

export const STILL_STARTING = "workspace_still_starting"

export function workspaceStartTransition(state: WorkspaceStartState, event: WorkspaceStartEvent): WorkspaceStartState {
  switch (event.type) {
    case "startRequested":
      return state.kind === "starting" ? state : { kind: "starting" }
    case "provisioning":
      if (state.kind !== "starting") return state
      return event.bootMode ? { kind: "starting", bootMode: event.bootMode } : state
    case "started":
      return state.kind === "starting" ? { kind: "stopped" } : state
    case "startFailed":
      return state.kind === "starting" ? { kind: "failed", error: event.error } : state
    default:
      return unreachable(event)
  }
}
