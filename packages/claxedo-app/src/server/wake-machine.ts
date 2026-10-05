import { unreachable } from "../lib/machine"
import type { WorkspaceBootMode } from "./cloud-types"
import type { AppError } from "./types"

export type WakeState =
  | { readonly kind: "idle" }
  | { readonly kind: "waking"; readonly bootMode?: WorkspaceBootMode }
  | { readonly kind: "failed"; readonly error: AppError }
  | { readonly kind: "outdated" }

export type WakeEvent =
  | { readonly type: "wakeStarted" }
  | { readonly type: "provisioning"; readonly bootMode?: WorkspaceBootMode }
  | { readonly type: "woke" }
  | { readonly type: "wakeFailed"; readonly error: AppError }
  | { readonly type: "imageOutdated" }

export const WAKE_IDLE: WakeState = { kind: "idle" }

export function wakeTransition(state: WakeState, event: WakeEvent): WakeState {
  switch (event.type) {
    case "wakeStarted":
      return state.kind === "waking" ? state : { kind: "waking" }
    case "provisioning":
      if (state.kind !== "waking") return state
      return event.bootMode ? { kind: "waking", bootMode: event.bootMode } : state
    case "woke":
      return state.kind === "waking" ? WAKE_IDLE : state
    case "wakeFailed":
      return state.kind === "waking" ? { kind: "failed", error: event.error } : state
    case "imageOutdated":
      return state.kind === "waking" ? state : { kind: "outdated" }
    default:
      return unreachable(event)
  }
}
