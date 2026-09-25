import type { AppError, PlacementId, Terminal, TerminalAgentStatus, TerminalId, TerminalStreamClose } from "@/server"
import { unreachable } from "@/lib/machine"

export type TerminalRow = Terminal & { readonly agentStatus?: TerminalAgentStatus; readonly seen?: boolean }

export type TerminalPaneState = {
  readonly placementId: PlacementId
  readonly terminalId: TerminalId
}

export type TerminalFailure = "closed" | "overload" | "restore" | "start"

export type TerminalConnection =
  | { readonly kind: "connecting" }
  | { readonly kind: "attached" }
  | { readonly kind: "detached"; readonly attempt: number; readonly error: AppError }
  | { readonly kind: "failed"; readonly failure: TerminalFailure; readonly error: AppError }
  | { readonly kind: "ended" }

export type TerminalConnectionEvent =
  | { readonly type: "opened" }
  | { readonly type: "closed"; readonly error: AppError }
  | { readonly type: "failed"; readonly failure: TerminalFailure; readonly error: AppError }
  | { readonly type: "retry" }
  | { readonly type: "ended" }

export function transitionConnection(state: TerminalConnection, event: TerminalConnectionEvent): TerminalConnection {
  switch (event.type) {
    case "opened":
      return state.kind === "connecting" ? { kind: "attached" } : state
    case "closed": {
      const attempt = state.kind === "detached" ? state.attempt + 1 : 1
      return { kind: "detached", attempt, error: event.error }
    }
    case "failed":
      return { kind: "failed", failure: event.failure, error: event.error }
    case "retry":
      return state.kind === "detached" || state.kind === "failed" ? { kind: "connecting" } : state
    case "ended":
      return { kind: "ended" }
    default:
      return unreachable(event)
  }
}

export type TerminalLoad =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly error: AppError }

export type TerminalLoadEvent =
  { readonly type: "started" } | { readonly type: "loaded" } | { readonly type: "failed"; readonly error: AppError }

export function transitionLoad(state: TerminalLoad, event: TerminalLoadEvent): TerminalLoad {
  switch (event.type) {
    case "started":
      return state.kind === "loading" ? state : { kind: "loading" }
    case "loaded":
      return { kind: "ready" }
    case "failed":
      return { kind: "failed", error: event.error }
    default:
      return unreachable(event)
  }
}

export function closeError(close: TerminalStreamClose): AppError {
  return {
    class: "network",
    message: `Terminal stream closed with ${close.code}: ${close.reason}`,
    retryable: close.code !== 1008,
    code: String(close.code),
    cause: close,
  }
}
