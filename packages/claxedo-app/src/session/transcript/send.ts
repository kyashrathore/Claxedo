import { promptEcho, toAppError, type PromptInput } from "@/server"
import type { SentPrompt } from "@/session"
import type { OptimisticUserMessage } from "@/transcript"
import type { TranscriptContext } from "./context"
import { removeMessage, upsertMessage } from "./conversation"

export function pendingMessage(sessionId: string, prompt: SentPrompt): OptimisticUserMessage | undefined {
  if (prompt.goal) return undefined
  const echo = promptEcho(prompt, { sessionId, messageId: prompt.messageId, created: prompt.sentAt })
  return { ...echo.info, origin: "optimistic", parts: echo.parts }
}

export function showSent(context: TranscriptContext, prompt: SentPrompt): void {
  const message = pendingMessage(context.ref.sessionId, prompt)
  if (message) upsertMessage(context.setData, message)
  context.deps.list.sendStarted(context.ref.sessionId, prompt.clientRequestId, prompt.sentAt)
}

export async function sendPrompt(context: TranscriptContext, input: PromptInput): Promise<void> {
  const { server, ref, deps, setData } = context
  const prompt = { ...input, messageId: input.messageId ?? server.sessions.newMessageId(), sentAt: Date.now() }
  showSent(context, prompt)
  try {
    await server.sessions.prompt(ref, prompt)
  } catch (cause) {
    removeMessage(setData, prompt.messageId)
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
