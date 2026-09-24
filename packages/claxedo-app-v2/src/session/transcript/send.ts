import type { PromptInput } from "@/server"
import { toAppError } from "../requests"
import type { TranscriptContext } from "./context"
import { removeMessage, upsertMessage } from "./conversation"

export async function sendPrompt(context: TranscriptContext, input: PromptInput): Promise<void> {
  const { server, ref, deps, setData } = context
  const messageId = input.messageId ?? server.sessions.newMessageId()
  const at = Date.now()
  upsertMessage(setData, { origin: "optimistic", id: messageId, role: "user", sessionID: ref.sessionId, time: { created: at } })
  deps.list.sendStarted(ref.sessionId, input.clientRequestId, at)
  try {
    await server.sessions.prompt(ref, { ...input, messageId })
  } catch (cause) {
    removeMessage(setData, messageId)
    deps.list.sendFailed(ref.sessionId, input.clientRequestId)
    throw toAppError(cause)
  }
  void context.queue.reread()
}

export async function stopTurn(context: TranscriptContext): Promise<void> {
  try {
    await context.server.sessions.stop(context.ref)
  } catch (cause) {
    throw toAppError(cause)
  }
}
