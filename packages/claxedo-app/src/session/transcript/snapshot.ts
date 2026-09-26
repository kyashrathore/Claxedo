import { toAppError, type SessionReads, type SessionSurfaceRead, type TranscriptPage } from "@/server"
import type { TranscriptContext } from "./context"
import { replaceLatest } from "./conversation"
import { applyTranscriptEvent } from "./events"
import { isPendingMessage } from "./merge"
import { completeLatestTurn, surfaceFragments } from "./latest-turn"
import { isReading } from "./model"

function hasOlderLoaded(context: TranscriptContext, transcript: TranscriptPage): boolean {
  const first = transcript.entries[0]?.info.id
  return first !== undefined && context.data.messages.some((message) => !isPendingMessage(message) && message.id < first)
}

function landSurface(context: TranscriptContext, surface: SessionSurfaceRead): void {
  const current = context.phase.state()
  const held = isReading(current) ? current.held : []
  context.deps.list.readRow(surface.row)
  replaceLatest(context.setData, surface.transcript)
  context.setData("fragmentParts", surfaceFragments(surface.transcript))
  if (!hasOlderLoaded(context, surface.transcript)) context.setOlderCursor(surface.transcript.olderCursor)
  context.setData("diff", [...surface.diff])
  for (const event of held) applyTranscriptEvent(context, event)
  context.phase.send({ type: "readLanded" })
}

function landSide<T>(context: TranscriptContext, what: string, read: Promise<T>, land: (value: T) => void): void {
  read.then(land, (cause) => {
    const error = toAppError(cause)
    if (error.class !== "not_found") console.warn(`A session's ${what} could not be read`, { sessionId: context.ref.sessionId, error })
  })
}

function landSides(context: TranscriptContext, reads: SessionReads, sentAt: number): void {
  const { ref, deps } = context
  landSide(context, "status", reads.status, (status) => deps.list.readStatus(ref, status, sentAt))
  reads.requests.then(
    (requests) => deps.requests.read(ref, requests, sentAt),
    (cause) => deps.requests.readFailed(ref, toAppError(cause), sentAt),
  )
  landSide(context, "todos", reads.todos, (todos) => context.todos.read(todos, sentAt))
  landSide(context, "goal", reads.goal, context.goal.read)
}

export function readSnapshot(context: TranscriptContext): Promise<void> {
  context.snapshotRead.current ??= readOnce(context).finally(() => {
    context.snapshotRead.current = undefined
  })
  return context.snapshotRead.current
}

async function readOnce(context: TranscriptContext): Promise<void> {
  context.phase.send({ type: "readStarted" })
  const sentAt = Date.now()
  const reads = context.server.sessions.read(context.ref)
  landSides(context, reads, sentAt)
  try {
    landSurface(context, await reads.surface)
    await completeLatestTurn(context)
  } catch (cause) {
    const error = toAppError(cause)
    context.phase.send(error.class === "not_found" ? { type: "readMissing" } : { type: "readFailed", error })
  }
}
