import { createMemo } from "solid-js"
import { unreachable } from "@/lib/machine"
import type { Server, ServerEvent, SessionRef } from "@/server"
import type { SessionLoadState, SessionView } from "@/session"
import type { TranscriptConversation } from "@/transcript"
import { createTranscriptContext, type TranscriptContext, type TranscriptDeps } from "./context"
import { NO_PARTS, lastUserMessageId } from "./conversation"
import { applyServerEvent } from "./events"
import { isPendingMessage, searchById } from "./merge"
import { isReading, type SessionPhase } from "./model"
import { loadOlder } from "./older"
import { sendPrompt, stopTurn } from "./send"
import { readSnapshot } from "./snapshot"

export type { TranscriptDeps } from "./context"

export type SessionTranscript = SessionView & {
  readonly apply: (event: ServerEvent) => void
  readonly gap: () => void
  readonly dispose: () => void
}

const LOADING: SessionLoadState = { kind: "loading" }
const READY: SessionLoadState = { kind: "ready" }
const MISSING: SessionLoadState = { kind: "missing" }

function loadState(phase: SessionPhase): SessionLoadState {
  switch (phase.kind) {
    case "loading":
      return LOADING
    case "ready":
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

function isPending(context: TranscriptContext, messageId: string): boolean {
  const { found, index } = searchById(context.data.messages, messageId)
  return found && isPendingMessage(context.data.messages[index])
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
    isPendingMessage: (messageId) => isPending(context, messageId),
    conversation: (): TranscriptConversation | undefined => (phase.state().kind === "loading" ? undefined : data),
    turnSettlePending: (userMessageId) => isReading(phase.state()) && lastUserId() === userMessageId,
    queue,
    requests: () => deps.requests.openFor(ref.sessionId),
    requestState: deps.requests.stateOf,
    todos: () => data.todos,
    diff: () => data.diff,
    goal: goal.goal,
    goalActions: goal.actions,
    controlGoal: goal.control,
    hasOlder: () => context.olderCursor() !== undefined,
    olderState: older.state,
    loadOlder: () => loadOlder(context),
    reload: () => readSnapshot(context),
    send: (input) => sendPrompt(context, input),
    stop: () => stopTurn(context),
    reply: (requestId, reply) => deps.requests.reply(ref, requestId, reply),
  }
}

export function createSessionTranscript(server: Server, ref: SessionRef, deps: TranscriptDeps): SessionTranscript {
  const context = createTranscriptContext(server, ref, deps)
  void readSnapshot(context)
  void context.queue.reread()
  return {
    ...sessionView(context),
    apply: (event) => applyServerEvent(context, event),
    gap: () => {
      void readSnapshot(context)
      void context.queue.reread()
    },
    dispose: context.deltas.drop,
  }
}
