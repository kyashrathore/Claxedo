import { unreachable } from "../lib/machine"
import type { WorkspaceBootMode, WorkspaceStartSteps } from "./cloud-types"
import type { AppError } from "./types"

export type WakeState =
  | { readonly kind: "idle" }
  | { readonly kind: "waking"; readonly bootMode?: WorkspaceBootMode; readonly failure?: string; readonly retryAt?: number; readonly steps?: WorkspaceStartSteps; readonly restart?: true; readonly followed?: true }
  | { readonly kind: "failed"; readonly error: AppError; readonly retryAt?: number; readonly restart?: true }
  | { readonly kind: "outdated" }

export type WakeEvent =
  | { readonly type: "wakeStarted"; readonly followed?: true }
  | { readonly type: "provisioning"; readonly bootMode?: WorkspaceBootMode; readonly failure?: string; readonly retryAt?: number; readonly steps?: WorkspaceStartSteps }
  | { readonly type: "woke" }
  | { readonly type: "wakeFailed"; readonly error: AppError; readonly retryAt?: number }
  | { readonly type: "imageOutdated" }
  | { readonly type: "imageCurrent" }

export const WAKE_IDLE: WakeState = { kind: "idle" }

const ANCHOR_JITTER_MS = 2_000

function steadyAnchor(previous: number, next: number): number {
  return Math.abs(previous - next) < ANCHOR_JITTER_MS ? Math.min(previous, next) : next
}

function steadySteps(previous: WorkspaceStartSteps | undefined, next: WorkspaceStartSteps | undefined): WorkspaceStartSteps | undefined {
  if (!next || !previous) return next ?? previous
  return { done: next.done, startedAt: steadyAnchor(previous.startedAt, next.startedAt), stepStartedAt: steadyAnchor(previous.stepStartedAt, next.stepStartedAt) }
}

function isRestart(state: WakeState): boolean {
  return state.kind === "outdated" || (state.kind === "failed" && state.restart === true)
}

export function wakeTransition(state: WakeState, event: WakeEvent): WakeState {
  switch (event.type) {
    case "wakeStarted":
      if (state.kind === "waking") return state
      return { kind: "waking", ...(isRestart(state) ? { restart: true } : {}), ...(event.followed ? { followed: true } : {}) }
    case "provisioning": {
      if (state.kind !== "waking") return state
      const bootMode = event.bootMode ?? state.bootMode
      const steps = steadySteps(state.steps, event.steps)
      return {
        kind: "waking",
        ...(bootMode ? { bootMode } : {}),
        ...(event.failure ? { failure: event.failure } : {}),
        ...(event.failure && event.retryAt !== undefined ? { retryAt: event.retryAt } : {}),
        ...(steps ? { steps } : {}),
        ...(state.restart ? { restart: true } : {}),
        ...(state.followed ? { followed: true } : {}),
      }
    }
    case "woke":
      return state.kind === "waking" ? WAKE_IDLE : state
    case "wakeFailed":
      if (state.kind !== "waking") return state
      return { kind: "failed", error: event.error, ...(event.retryAt !== undefined ? { retryAt: event.retryAt } : {}), ...(state.restart ? { restart: true } : {}) }
    case "imageOutdated":
      return state.kind === "waking" || (state.kind === "failed" && state.restart) ? state : { kind: "outdated" }
    case "imageCurrent":
      return isRestart(state) ? WAKE_IDLE : state
    default:
      return unreachable(event)
  }
}
