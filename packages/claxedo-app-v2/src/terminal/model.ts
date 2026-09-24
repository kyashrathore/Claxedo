import type { AppError, Terminal, TerminalAgentStatus, TerminalStreamClose } from "@/server"
import { unreachable } from "@/lib/machine"

export type TerminalRow = Terminal & { readonly agentStatus?: TerminalAgentStatus }

export type TerminalConnection =
  | { readonly kind: "connecting" }
  | { readonly kind: "attached" }
  | { readonly kind: "detached"; readonly attempt: number; readonly error: AppError }
  | { readonly kind: "gone" }
  | { readonly kind: "exited"; readonly code?: number }

export type TerminalConnectionEvent =
  | { readonly type: "opened" }
  | { readonly type: "closed"; readonly error: AppError }
  | { readonly type: "retry" }
  | { readonly type: "gone" }
  | { readonly type: "exited"; readonly code?: number }

export function transitionConnection(state: TerminalConnection, event: TerminalConnectionEvent): TerminalConnection {
  switch (event.type) {
    case "opened":
      return state.kind === "connecting" ? { kind: "attached" } : state
    case "closed": {
      const attempt = state.kind === "detached" ? state.attempt + 1 : 1
      return { kind: "detached", attempt, error: event.error }
    }
    case "retry":
      return state.kind === "detached" || state.kind === "gone" ? { kind: "connecting" } : state
    case "gone":
      return { kind: "gone" }
    case "exited":
      return { kind: "exited", ...(event.code === undefined ? {} : { code: event.code }) }
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
  | { readonly type: "started" }
  | { readonly type: "loaded" }
  | { readonly type: "failed"; readonly error: AppError }

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

export function isAppError(value: unknown): value is AppError {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.class === "string" && typeof record.message === "string" && typeof record.retryable === "boolean"
}

export function asAppError(cause: unknown, message: string): AppError {
  if (isAppError(cause)) return cause
  return { class: "internal", message, retryable: false, cause }
}

export function closeError(close: TerminalStreamClose, message: string): AppError {
  return { class: "network", message, retryable: close.code !== 1008, code: String(close.code), cause: close }
}
