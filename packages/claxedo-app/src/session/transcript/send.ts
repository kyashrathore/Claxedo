import { promptEcho, toAppError, type PromptInput } from "@/server"
import type { SentPrompt } from "@/session"
import type { OptimisticUserMessage } from "@/transcript"
import type { TranscriptContext } from "./context"
import { removeOptimisticMessage, upsertMessage } from "./conversation"
import { isRuntimeMessage, searchById } from "./merge"

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

function runtimeHolds(context: TranscriptContext, messageId: string): boolean {
  const { found, index } = searchById(context.data.messages, messageId)
  if (found && isRuntimeMessage(context.data.messages[index])) return true
  return context.queue.items().some((item) => item.messageId === messageId)
}

export async function sendPrompt(context: TranscriptContext, input: PromptInput): Promise<void> {
  const { server, ref, deps, setData } = context
  const prompt = { ...input, messageId: input.messageId ?? server.sessions.newMessageId(), sentAt: Date.now() }
  showSent(context, prompt)
  try {
    await server.sessions.prompt(ref, prompt)
  } catch (cause) {
    if (runtimeHolds(context, prompt.messageId)) return void context.queue.reread()
    removeOptimisticMessage(setData, prompt.messageId)
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
