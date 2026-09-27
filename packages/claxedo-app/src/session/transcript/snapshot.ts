import { batch } from "solid-js"
import { toAppError, type HeldSessionReads, type SessionReads, type SessionSurfaceRead } from "@/server"
import type { TranscriptContext } from "./context"
import { replaceLatest } from "./conversation"
import { applyTranscriptEvent } from "./events"
import { adoptOlderCursor, completeLatestTurn, surfaceFragments } from "./latest-turn"
import { isReading, NO_FRAGMENTS } from "./model"

function landSurface(context: TranscriptContext, surface: SessionSurfaceRead): void {
  const current = context.phase.state()
  const held = isReading(current) ? current.held : []
  batch(() => {
    context.deps.list.readRow(surface.row)
    replaceLatest(context.setData, surface.transcript)
    context.setData("fragmentParts", surface.latestTurnComplete ? NO_FRAGMENTS : surfaceFragments(surface.transcript))
    context.latestTurnRead.current = surface.latestTurnComplete ? surface.transcript : undefined
    adoptOlderCursor(context, surface.transcript)
    context.setData("diff", [...surface.diff])
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
  reads.requests.then(
    (requests) => deps.requests.read(ref, requests, sentAt),
    (cause) => deps.requests.readFailed(ref, toAppError(cause), sentAt),
  )
  landSide(context, "todos", reads.todos, (todos) => context.todos.read(todos, sentAt))
  landSide(context, "goal", reads.goal, context.goal.read)
  landSide(context, "subagents", reads.subagents, context.subagents.read)
  reads.outline.then(
    (outline) => context.outline.send({ type: "outlineLanded", outline, sentAt }),
    (cause) => context.outline.send({ type: "outlineFailed", error: toAppError(cause), sentAt }),
  )
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
  const reads = context.server.sessions.read(context.ref, held)
  landSides(context, reads, sentAt)
  try {
    landSurface(context, await reads.surface)
    await completeLatestTurn(context)
  } catch (cause) {
    const error = toAppError(cause)
    context.phase.send(error.class === "not_found" ? { type: "readMissing" } : { type: "readFailed", error })
  }
}
