import { batch } from "solid-js"
import { toAppError, type TranscriptPage } from "@/server"
import type { TranscriptContext } from "./context"
import { mergeLatestTurn } from "./conversation"
import { applyTranscriptEvent } from "./events"
import { isOptimisticMessage } from "./merge"
import { NO_FRAGMENTS } from "./model"

export function surfaceFragments(page: TranscriptPage): ReadonlySet<string> {
  return new Set(page.entries.filter((entry) => entry.info.role === "assistant").map((entry) => entry.info.id))
}

function hasOlderLoaded(context: TranscriptContext, page: TranscriptPage): boolean {
  const first = page.entries[0]?.info.id
  return first !== undefined && context.data.messages.some((message) => !isOptimisticMessage(message) && message.id < first)
}

export function adoptOlderCursor(context: TranscriptContext, page: TranscriptPage): void {
  if (!hasOlderLoaded(context, page)) context.setOlderCursor(page.olderCursor)
}

function land(context: TranscriptContext, page: TranscriptPage | undefined): void {
  const current = context.phase.state()
  if (current.kind !== "completing") return
  batch(() => {
    if (page) {
      mergeLatestTurn(context.setData, page)
      context.latestTurnRead.current = page
      adoptOlderCursor(context, page)
    }
    context.setData("fragmentParts", NO_FRAGMENTS)
    for (const event of current.held) applyTranscriptEvent(context, event)
    context.phase.send({ type: "latestLanded" })
  })
}

export async function completeLatestTurn(context: TranscriptContext): Promise<void> {
  if (context.data.fragmentParts.size === 0) return
  context.phase.send({ type: "latestStarted" })
  if (context.phase.state().kind !== "completing") return
  try {
    land(context, await context.server.sessions.latestTurn(context.ref))
  } catch (cause) {
    console.error("The latest turn could not be read in full", { sessionId: context.ref.sessionId, error: toAppError(cause) })
    land(context, undefined)
  }
}
