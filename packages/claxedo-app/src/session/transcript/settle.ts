import { toAppError, type SessionStatus } from "@/server"
import type { TranscriptContext } from "./context"
import { lastUserMessageId, mergePage } from "./conversation"

export async function settleTurn(context: TranscriptContext): Promise<void> {
  const turnId = lastUserMessageId(context.data.messages)
  if (!turnId) return
  try {
    const page = await context.server.sessions.turn(context.ref, turnId)
    mergePage(context.setData, page)
  } catch (cause) {
    console.error("The settled turn could not be read", { sessionId: context.ref.sessionId, turnId, error: toAppError(cause) })
  }
}

export function settleEndedTurn(context: TranscriptContext, status: SessionStatus): Promise<void> | undefined {
  if (status.kind !== "idle" && status.kind !== "interrupted" && status.kind !== "failed") return undefined
  return settleTurn(context)
}
