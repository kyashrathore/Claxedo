import { batch } from "solid-js"
import { toAppError } from "@/server"
import type { TranscriptContext } from "./context"
import { lastUserMessageId } from "./conversation"
import { applyServerEvent } from "./events"

export async function settleTurn(context: TranscriptContext): Promise<void> {
  const turnId = lastUserMessageId(context.data.messages)
  if (!turnId) return
  try {
    const page = await context.server.sessions.turn(context.ref, turnId)
    batch(() => {
      for (const entry of page.entries) {
        applyServerEvent(context, { type: "messageUpserted", ref: context.ref, message: entry.info })
        for (const part of entry.parts) applyServerEvent(context, { type: "partUpserted", ref: context.ref, part })
      }
    })
  } catch (cause) {
    console.error("The settled turn could not be read", { sessionId: context.ref.sessionId, turnId, error: toAppError(cause) })
  }
}
