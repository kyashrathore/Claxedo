import { createMemo, onCleanup } from "solid-js"
import { unreachable } from "@/lib/machine"
import type { Server, ServerEvent, SessionOutline, SessionRef, TranscriptPage } from "@/server"
import type { SessionLoadState, SessionView } from "@/session"
import type { TranscriptConversation } from "@/transcript"
import { createTranscriptContext, type TranscriptContext, type TranscriptDeps } from "./context"
import { NO_PARTS, lastUserMessageId } from "./conversation"
import { applyServerEvent } from "./events"
import { settleTurn } from "./settle"
import { isReading, type SessionPhase } from "./model"
import { loadOlder } from "./older"
import { sendPrompt, showSent, stopTurn } from "./send"
import { retainedSession, type RetainedSession } from "./retained"
import { readSnapshot } from "./snapshot"

export type { TranscriptDeps } from "./context"

export type SessionTranscript = SessionView & {
  readonly apply: (event: ServerEvent) => void
  readonly gap: () => void
  readonly retained: () => RetainedSession | undefined
}

export type { RetainedSession } from "./retained"

export type TranscriptSeed = { readonly latestTurn: TranscriptPage; readonly outline: SessionOutline | undefined }

const LOADING: SessionLoadState = { kind: "loading" }
const READY: SessionLoadState = { kind: "ready" }
const MISSING: SessionLoadState = { kind: "missing" }

function loadState(phase: SessionPhase): SessionLoadState {
  switch (phase.kind) {
    case "loading":
      return LOADING
    case "ready":
    case "completing":
    case "rereading":
      return READY
    case "missing":
      return MISSING
    case "failed":
      return { kind: "failed", message: phase.error.message, error: phase.error }
    default:
      return unreachable(phase)
  }
}

function sessionView(context: TranscriptContext): SessionView {
  const { ref, deps, data, phase, older, goal, queue } = context
  const state = createMemo(() => loadState(phase.state()))
  const lastUserId = createMemo(() => lastUserMessageId(data.messages))
  return {
    ref,
    state,
    row: () => deps.list.rowOf(ref.sessionId),
    status: () => deps.list.statusOf(ref.sessionId),
    messages: () => data.messages,
    parts: (messageId) => data.parts[messageId] ?? NO_PARTS,
    pendingDeltas: context.deltas.pending,
    commitDeltas: context.deltas.commit,
    conversation: (): TranscriptConversation | undefined => (phase.state().kind === "loading" ? undefined : data),
    turnSettlePending: (userMessageId) => isReading(phase.state()) && lastUserId() === userMessageId,
    queue,
    replaceQueued: (seq, input) => context.queue.replace(seq, input),
    requests: () => deps.requests.openFor(ref.sessionId),
    requestsError: () => deps.requests.readErrorFor(ref.sessionId),
    requestState: deps.requests.stateOf,
    todos: context.todos.list,
    diff: () => data.diff,
    subagents: context.subagents.list,
    goal: goal.goal,
    goalActions: goal.actions,
    goalAvailable: goal.available,
    controlGoal: goal.control,
    hasOlder: () => context.olderCursor() !== undefined,
    olderState: older.state,
    outline: context.outline.state,
    loadOlder: () => loadOlder(context),
    reload: () => readSnapshot(context),
    send: (input) => sendPrompt(context, input),
    showSent: (prompt) => showSent(context, prompt),
    stop: () => stopTurn(context),
    reply: (requestId, reply) => deps.requests.reply(ref, requestId, reply),
  }
}

export function createSessionTranscript(server: Server, ref: SessionRef, deps: TranscriptDeps, seed?: TranscriptSeed): SessionTranscript {
  const context = createTranscriptContext(server, ref, deps)
  onCleanup(server.attachPlacement(ref.placementId))
  void readSnapshot(context, seed)
  void context.queue.reread()
  return {
    ...sessionView(context),
    retained: () => retainedSession(context),
    apply: (event) => {
      applyServerEvent(context, event)
      if (event.type === "statusChanged" && event.status.kind === "idle") void settleTurn(context)
    },
    gap: () => {
      void readSnapshot(context)
      void context.queue.reread()
      context.subagents.reread()
    },
  }
}
