import type { SessionSnapshot } from "@/server"
import { toAppError } from "../requests"
import type { TranscriptContext } from "./context"
import { replaceLatest } from "./conversation"
import { applyTranscriptEvent } from "./events"
import { isPendingMessage } from "./merge"
import { completeLatestTurn, surfaceFragments } from "./latest-turn"
import { isReading } from "./model"

function hasOlderLoaded(context: TranscriptContext, snapshot: SessionSnapshot): boolean {
  const first = snapshot.transcript.entries[0]?.info.id
  return first !== undefined && context.data.messages.some((message) => !isPendingMessage(message) && message.id < first)
}

function landSnapshot(context: TranscriptContext, snapshot: SessionSnapshot, sentAt: number): void {
  const current = context.phase.state()
  const held = isReading(current) ? current.held : []
  context.deltas.drop()
  context.deps.list.readRow(snapshot.row)
  context.deps.list.readStatus(context.ref, snapshot.status, sentAt)
  context.deps.requests.read(context.ref, snapshot.requests, sentAt)
  replaceLatest(context.setData, snapshot.transcript)
  context.setData("fragmentParts", surfaceFragments(snapshot.transcript))
  if (!hasOlderLoaded(context, snapshot)) context.setOlderCursor(snapshot.transcript.olderCursor)
  context.setData("todos", [...snapshot.todos])
  context.setData("diff", [...snapshot.diff])
  context.goal.read(snapshot.goal)
  for (const event of held) applyTranscriptEvent(context, event)
  context.phase.send({ type: "readLanded" })
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
  try {
    landSnapshot(context, await context.server.sessions.snapshot(context.ref), sentAt)
    await completeLatestTurn(context)
  } catch (cause) {
    const error = toAppError(cause)
    context.phase.send(error.class === "not_found" ? { type: "readMissing" } : { type: "readFailed", error })
  }
}
