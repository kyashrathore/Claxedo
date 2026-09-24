import { toAppError } from "../requests"
import type { TranscriptContext } from "./context"
import { lastUserMessageId } from "./conversation"
import { applyServerEvent } from "./events"

/**
 * A turn can end with `session.idle` and no update carrying the assistant
 * message's completion time (the ACP harness sends none); without it the turn
 * never reads as settled and never folds. So a settled turn is read once by its
 * user message id, as today's app reads each turn it sent, and merged like the
 * stream's own updates: a read racing the next turn's deltas replaces nothing.
 */
export async function settleTurn(context: TranscriptContext): Promise<void> {
  const turnId = lastUserMessageId(context.data.messages)
  if (!turnId) return
  try {
    const page = await context.server.sessions.turn(context.ref, turnId)
    for (const entry of page.entries) {
      applyServerEvent(context, { type: "messageUpserted", ref: context.ref, message: entry.info })
      for (const part of entry.parts) applyServerEvent(context, { type: "partUpserted", ref: context.ref, part })
    }
  } catch (cause) {
    console.error("The settled turn could not be read", { sessionId: context.ref.sessionId, turnId, error: toAppError(cause) })
  }
}
