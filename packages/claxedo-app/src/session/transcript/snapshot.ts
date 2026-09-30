import { batch } from "solid-js"
import { toAppError, type HeldSessionReads, type SessionFirstRead, type SessionReads, type TranscriptPage } from "@/server"
import type { TranscriptContext } from "./context"
import { replaceLatest } from "./conversation"
import { applyTranscriptEvent } from "./events"
import { isOptimisticMessage } from "./merge"
import { isReading, outlineOf } from "./model"

function hasOlderLoaded(context: TranscriptContext, page: TranscriptPage): boolean {
  const first = page.entries[0]?.info.id
  return first !== undefined && context.data.messages.some((message) => !isOptimisticMessage(message) && message.id < first)
}

function landFirst(context: TranscriptContext, first: SessionFirstRead): void {
  const current = context.phase.state()
  const held = isReading(current) ? current.held : []
  batch(() => {
    context.deps.list.readRow(first.row)
    replaceLatest(context.setData, first.transcript)
    context.latestTurnRead.current = first.latestTurn
    if (!hasOlderLoaded(context, first.transcript)) context.setOlderCursor(first.transcript.olderCursor)
    context.setData("diff", [...first.diff])
    context.setOutline(outlineOf(first.outline))
    for (const event of held) applyTranscriptEvent(context, event)
    context.phase.send({ type: "readLanded" })
  })
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
  landSide(context, "background work", reads.backgroundWork, (work) => deps.list.readBackgroundWork(ref, work, sentAt))
  reads.requests.then(
    (requests) => deps.requests.read(ref, requests, sentAt),
    (cause) => deps.requests.readFailed(ref, toAppError(cause), sentAt),
  )
  landSide(context, "todos", reads.todos, (todos) => context.todos.read(todos, sentAt))
  landSide(context, "goal", reads.goal, context.goal.read)
  landSide(context, "subagents", reads.subagents, context.subagents.read)
}

export function readSnapshot(context: TranscriptContext, held?: HeldSessionReads): Promise<void> {
  context.snapshotRead.current ??= readOnce(context, held).finally(() => {
    context.snapshotRead.current = undefined
  })
  return context.snapshotRead.current
}

async function readOnce(context: TranscriptContext, held?: HeldSessionReads): Promise<void> {
  context.phase.send({ type: "readStarted" })
  const sentAt = Date.now()
  const reads = context.server.sessions.read(context.ref, context.deps.pageShape(), held)
  landSides(context, reads, sentAt)
  try {
    landFirst(context, await reads.first)
  } catch (cause) {
    const error = toAppError(cause)
    context.phase.send(error.class === "not_found" ? { type: "readMissing" } : { type: "readFailed", error })
  }
}
