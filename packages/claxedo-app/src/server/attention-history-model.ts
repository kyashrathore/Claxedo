import { unreachable } from "../lib/machine"
import type { AppError } from "./types"

export type HistoryState =
  | { readonly kind: "ready"; readonly cursor: number; readonly revision: number }
  | { readonly kind: "reading"; readonly cursor: number; readonly revision: number; readonly requested: boolean; readonly reset: boolean }
  | { readonly kind: "failed"; readonly cursor: number; readonly revision: number; readonly error: AppError }

export type HistoryEvent =
  | { readonly type: "requested"; readonly reset: boolean }
  | { readonly type: "pageReceived"; readonly revision: number; readonly cursor: number; readonly more: boolean }
  | { readonly type: "failed"; readonly revision: number; readonly error: AppError }

export function historyTransition(state: HistoryState, event: HistoryEvent): HistoryState {
  switch (event.type) {
    case "requested":
      return state.kind === "reading" ? { ...state, requested: true, reset: state.reset || event.reset }
        : { kind: "reading", cursor: event.reset ? 0 : state.cursor, revision: state.revision + 1, requested: false, reset: false }
    case "pageReceived":
      if (state.kind !== "reading" || state.revision !== event.revision) return state
      if (state.reset || state.requested || event.more) return { kind: "reading", cursor: state.reset ? 0 : event.cursor, revision: state.revision + 1, requested: false, reset: false }
      return { kind: "ready", cursor: event.cursor, revision: state.revision }
    case "failed":
      return state.kind === "reading" && state.revision === event.revision ? { kind: "failed", cursor: state.reset ? 0 : state.cursor, revision: state.revision, error: event.error } : state
    default:
      return unreachable(event)
  }
}
