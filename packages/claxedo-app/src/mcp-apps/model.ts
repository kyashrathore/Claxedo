import { unreachable } from "@/lib/machine"

export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26"

export const MCP_APP_HOST_INFO = { name: "Claxedo", version: "1.0.0" } as const

export const DEFAULT_APP_HEIGHT = 320
export const MIN_APP_HEIGHT = 80
export const MAX_APP_HEIGHT = 2000

export const MAX_FRAME_MESSAGE_BYTES = 256 * 1024
export const MAX_REQUESTS_IN_FLIGHT = 16
export const TEARDOWN_WAIT_MS = 2_000

export type DisplayMode = "inline" | "fullscreen"

export const DISPLAY_MODES: readonly DisplayMode[] = ["inline", "fullscreen"]

export type AppDocument =
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly html: string }
  | { readonly kind: "invalid" }

export type AppFrameState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "stopped" }

export type AppFrameEvent =
  | { readonly type: "initialized" }
  | { readonly type: "operationUnavailable" }
  | { readonly type: "operationAnswered" }
  | { readonly type: "navigated" }

export function appFrameTransition(state: AppFrameState, event: AppFrameEvent): AppFrameState {
  switch (event.type) {
    case "initialized":
      return state.kind === "loading" ? { kind: "ready" } : state
    case "operationUnavailable":
      return state.kind === "ready" ? { kind: "unavailable" } : state
    case "operationAnswered":
      return state.kind === "unavailable" ? { kind: "ready" } : state
    case "navigated":
      return { kind: "stopped" }
    default:
      return unreachable(event)
  }
}

export function clampAppHeight(height: number): number {
  return Math.min(MAX_APP_HEIGHT, Math.max(MIN_APP_HEIGHT, Math.round(height)))
}

export type BridgePhase =
  | { readonly kind: "waiting" }
  | { readonly kind: "initializing" }
  | { readonly kind: "open" }
  | { readonly kind: "closed" }

export type BridgeEvent =
  | { readonly type: "initializeAnswered" }
  | { readonly type: "initializedReceived" }
  | { readonly type: "closed" }

export function bridgeTransition(phase: BridgePhase, event: BridgeEvent): BridgePhase {
  switch (event.type) {
    case "initializeAnswered":
      return phase.kind === "waiting" ? { kind: "initializing" } : phase
    case "initializedReceived":
      return phase.kind === "initializing" ? { kind: "open" } : phase
    case "closed":
      return { kind: "closed" }
    default:
      return unreachable(event)
  }
}
