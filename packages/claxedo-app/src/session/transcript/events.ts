import { unreachable } from "@/lib/machine"
import type { ServerEvent, TranscriptMessage } from "@/server"
import type { TranscriptContext } from "./context"
import { removeMessage, removePart, upsertMessage, upsertPart } from "./conversation"
import { isPresentationMessage } from "./merge"
import { isReading, isTranscriptEvent, type TranscriptEvent } from "./model"

function upsertInfo(context: TranscriptContext, info: TranscriptMessage): void {
  if (!isPresentationMessage(info)) return
  upsertMessage(context.setData, info)
  if (info.role === "user") void context.queue.reread()
}

export function applyTranscriptEvent(context: TranscriptContext, event: TranscriptEvent): void {
  switch (event.type) {
    case "messageUpserted":
      return upsertInfo(context, event.message)
    case "messageRemoved":
      return removeMessage(context.setData, event.messageId)
    case "partUpserted":
      return upsertPart(context.setData, event.part)
    case "partRemoved":
      return removePart(context.setData, event.messageId, event.partId)
    case "todosChanged":
      return context.todos.changed(event.todos)
    case "diffChanged":
      return context.setData("diff", [...event.diff])
    case "goalChanged":
      return context.goal.changed(event.goal)
    default:
      return unreachable(event)
  }
}

export function applyServerEvent(context: TranscriptContext, event: ServerEvent): void {
  if (event.type === "partDelta") return context.deltas.add(event)
  if (event.type === "statusChanged") return void context.queue.reread()
  if (event.type === "subagentUpdated") return context.subagents.apply(event.subagent)
  if (!isTranscriptEvent(event)) return
  if (isReading(context.phase.state())) return context.phase.send({ type: "held", event })
  applyTranscriptEvent(context, event)
}
