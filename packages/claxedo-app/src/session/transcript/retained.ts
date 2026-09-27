import { unwrap } from "solid-js/store"
import type { SessionOutline, TranscriptPage } from "@/server"
import type { TranscriptContext } from "./context"
import { lastUserMessageId, NO_PARTS } from "./conversation"
import { isOptimisticMessage } from "./merge"

export type RetainedSession = { readonly latestTurn: TranscriptPage; readonly outline: SessionOutline | undefined }

function retainedLatestTurn(context: TranscriptContext): TranscriptPage | undefined {
  const read = context.latestTurnRead.current
  const messages = unwrap(context.data.messages)
  const userId = lastUserMessageId(messages)
  if (!read || !userId || read.entries[0]?.info.id !== userId) return undefined
  if (context.phase.state().kind !== "ready" || context.deltas.pending() || context.deps.list.statusOf(context.ref.sessionId).kind !== "idle") return undefined
  const turn = messages.slice(messages.findIndex((message) => message.id === userId))
  if (turn.some(isOptimisticMessage)) return undefined
  const parts = unwrap(context.data.parts)
  return {
    entries: turn.map((info) => ({ info, parts: parts[info.id] ?? NO_PARTS })),
    ...(read.olderCursor ? { olderCursor: read.olderCursor } : {}),
  }
}

export function retainedSession(context: TranscriptContext): RetainedSession | undefined {
  const latestTurn = retainedLatestTurn(context)
  if (!latestTurn) return undefined
  const outline = context.outline()
  return { latestTurn, outline: outline.kind === "ready" ? outline.outline : undefined }
}
