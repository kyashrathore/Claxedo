import { unreachable } from "@/lib/machine"
import type { AppError, FileDiff, ServerEvent, TranscriptPart } from "@/server"
import type { OlderState } from "@/session"
import type { ConversationMessage } from "@/transcript"

export type TranscriptData = {
  messages: ConversationMessage[]
  parts: Record<string, TranscriptPart[]>
  fragmentParts: ReadonlySet<string>
  partsWithText: Record<string, true>
  diff: FileDiff[]
}

export type TranscriptEvent = Extract<
  ServerEvent,
  { type: "messageUpserted" | "messageRemoved" | "partUpserted" | "partRemoved" | "todosChanged" | "diffChanged" | "goalChanged" }
>

export type SessionPhase =
  | { readonly kind: "loading"; readonly held: readonly TranscriptEvent[] }
  | { readonly kind: "ready" }
  | { readonly kind: "completing"; readonly held: readonly TranscriptEvent[] }
  | { readonly kind: "rereading"; readonly held: readonly TranscriptEvent[] }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly error: AppError }

export type SessionPhaseEvent =
  | { readonly type: "readStarted" }
  | { readonly type: "readLanded" }
  | { readonly type: "latestStarted" }
  | { readonly type: "latestLanded" }
  | { readonly type: "readMissing" }
  | { readonly type: "readFailed"; readonly error: AppError }
  | { readonly type: "held"; readonly event: TranscriptEvent }

export type OlderEvent =
  | { readonly type: "olderStarted" }
  | { readonly type: "olderLanded" }
  | { readonly type: "olderFailed"; readonly error: AppError }

export const NO_FRAGMENTS: ReadonlySet<string> = new Set()

export const emptyTranscript = (): TranscriptData => ({ messages: [], parts: {}, fragmentParts: NO_FRAGMENTS, partsWithText: {}, diff: [] })

export const initialPhase: SessionPhase = { kind: "loading", held: [] }

export const OLDER_IDLE: OlderState = { kind: "idle" }

export const isReading = (phase: SessionPhase): phase is Extract<SessionPhase, { kind: "loading" | "rereading" }> =>
  phase.kind === "loading" || phase.kind === "rereading"

export const isHolding = (phase: SessionPhase): phase is Extract<SessionPhase, { held: readonly TranscriptEvent[] }> =>
  isReading(phase) || phase.kind === "completing"

export function phaseTransition(state: SessionPhase, event: SessionPhaseEvent): SessionPhase {
  switch (event.type) {
    case "readStarted":
      if (isReading(state)) return state
      if (state.kind === "completing") return { kind: "rereading", held: state.held }
      return state.kind === "ready" ? { kind: "rereading", held: [] } : { kind: "loading", held: [] }
    case "readLanded":
      return isReading(state) ? { kind: "ready" } : state
    case "latestStarted":
      return state.kind === "ready" ? { kind: "completing", held: [] } : state
    case "latestLanded":
      return state.kind === "completing" ? { kind: "ready" } : state
    case "readMissing":
      return isReading(state) ? { kind: "missing" } : state
    case "readFailed":
      return isReading(state) ? { kind: "failed", error: event.error } : state
    case "held":
      return isHolding(state) ? { ...state, held: [...state.held, event.event] } : state
    default:
      return unreachable(event)
  }
}

export function olderTransition(state: OlderState, event: OlderEvent): OlderState {
  switch (event.type) {
    case "olderStarted":
      return state.kind === "loading" ? state : { kind: "loading" }
    case "olderLanded":
      return state.kind === "loading" ? OLDER_IDLE : state
    case "olderFailed":
      return state.kind === "loading" ? { kind: "failed", error: event.error } : state
    default:
      return unreachable(event)
  }
}

export const isTranscriptEvent = (event: ServerEvent): event is TranscriptEvent =>
  event.type === "messageUpserted" ||
  event.type === "messageRemoved" ||
  event.type === "partUpserted" ||
  event.type === "partRemoved" ||
  event.type === "todosChanged" ||
  event.type === "diffChanged" ||
  event.type === "goalChanged"
