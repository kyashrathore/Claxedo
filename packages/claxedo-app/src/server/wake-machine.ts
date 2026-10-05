import { unreachable } from "../lib/machine"
import type { WorkspaceBootMode } from "./cloud-types"
import type { AppError } from "./types"

export type WakeState =
  | { readonly kind: "idle" }
  | { readonly kind: "waking"; readonly bootMode?: WorkspaceBootMode; readonly restart?: true }
  | { readonly kind: "failed"; readonly error: AppError; readonly restart?: true }
  | { readonly kind: "outdated" }

export type WakeEvent =
  | { readonly type: "wakeStarted" }
  | { readonly type: "provisioning"; readonly bootMode?: WorkspaceBootMode }
  | { readonly type: "woke" }
  | { readonly type: "wakeFailed"; readonly error: AppError }
  | { readonly type: "imageOutdated" }
  | { readonly type: "imageCurrent" }

export const WAKE_IDLE: WakeState = { kind: "idle" }

function isRestart(state: WakeState): boolean {
  return state.kind === "outdated" || (state.kind === "failed" && state.restart === true)
}

export function wakeTransition(state: WakeState, event: WakeEvent): WakeState {
  switch (event.type) {
    case "wakeStarted":
      if (state.kind === "waking") return state
      return isRestart(state) ? { kind: "waking", restart: true } : { kind: "waking" }
    case "provisioning":
      if (state.kind !== "waking") return state
      return event.bootMode ? { ...state, bootMode: event.bootMode } : state
    case "woke":
      return state.kind === "waking" ? WAKE_IDLE : state
    case "wakeFailed":
      if (state.kind !== "waking") return state
      return state.restart ? { kind: "failed", error: event.error, restart: true } : { kind: "failed", error: event.error }
    case "imageOutdated":
      return state.kind === "waking" || (state.kind === "failed" && state.restart) ? state : { kind: "outdated" }
    case "imageCurrent":
      return isRestart(state) ? WAKE_IDLE : state
    default:
      return unreachable(event)
  }
}
