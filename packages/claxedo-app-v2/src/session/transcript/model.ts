import type { AgentPresentationMessage } from "@claxedo/agent-runtime-contract"
import { unreachable } from "@/lib/machine"
import type { AppError, FileDiff, ServerEvent, Todo, TranscriptPart } from "@/server"
import type { OlderState } from "@/session"
import type { OptimisticUserMessage } from "@/transcript"

export type PendingUserMessage = OptimisticUserMessage & { readonly sessionID: string }

export type SessionMessage = AgentPresentationMessage | PendingUserMessage

export type TranscriptData = {
  messages: SessionMessage[]
  parts: Record<string, TranscriptPart[]>
  fragmentParts: ReadonlySet<string>
  todos: Todo[]
  diff: FileDiff[]
}

export type TranscriptEvent = Extract<
  ServerEvent,
  { type: "messageUpserted" | "messageRemoved" | "partUpserted" | "partRemoved" | "todosChanged" | "diffChanged" }
>

export type SessionPhase =
  | { readonly kind: "loading"; readonly held: readonly TranscriptEvent[] }
  | { readonly kind: "ready" }
  | { readonly kind: "rereading"; readonly held: readonly TranscriptEvent[] }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly error: AppError }

export type SessionPhaseEvent =
  | { readonly type: "readStarted" }
  | { readonly type: "readLanded" }
  | { readonly type: "readMissing" }
  | { readonly type: "readFailed"; readonly error: AppError }
  | { readonly type: "held"; readonly event: TranscriptEvent }

export type OlderEvent =
  | { readonly type: "olderStarted" }
  | { readonly type: "olderLanded" }
  | { readonly type: "olderFailed"; readonly error: AppError }

const NO_FRAGMENTS: ReadonlySet<string> = new Set()

export const emptyTranscript = (): TranscriptData => ({ messages: [], parts: {}, fragmentParts: NO_FRAGMENTS, todos: [], diff: [] })

export const initialPhase: SessionPhase = { kind: "loading", held: [] }

export const OLDER_IDLE: OlderState = { kind: "idle" }

export const isReading = (phase: SessionPhase): phase is Extract<SessionPhase, { held: readonly TranscriptEvent[] }> =>
  phase.kind === "loading" || phase.kind === "rereading"

export function phaseTransition(state: SessionPhase, event: SessionPhaseEvent): SessionPhase {
  switch (event.type) {
    case "readStarted":
      if (isReading(state)) return state
      return state.kind === "ready" ? { kind: "rereading", held: [] } : { kind: "loading", held: [] }
    case "readLanded":
      return isReading(state) ? { kind: "ready" } : state
    case "readMissing":
      return isReading(state) ? { kind: "missing" } : state
    case "readFailed":
      return isReading(state) ? { kind: "failed", error: event.error } : state
    case "held":
      return isReading(state) ? { ...state, held: [...state.held, event.event] } : state
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
  event.type === "diffChanged"
