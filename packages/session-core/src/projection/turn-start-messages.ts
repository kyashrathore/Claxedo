import type { Turn } from "../store"
import { buildAssistantMessage, buildUserMessage, buildUserPromptParts } from "./presentation-events"

/** The prompt and the assistant message a turn start writes, read alike by its projection and by the events it publishes. */
export function turnStartMessages(input: { sessionId: string; ts: number; directory: string; control: Turn }) {
  const { sessionId, ts, control } = input
  return {
    user: control.userMessageId
      ? {
          info: buildUserMessage({
            id: control.userMessageId,
            sessionID: sessionId,
            agent: control.agent,
            model: control.model,
            created: ts,
            ...(control.tools ? { tools: control.tools } : {}),
            ...(control.format ? { format: control.format } : {}),
            ...(control.system ? { system: control.system } : {}),
            ...(control.variant ? { variant: control.variant } : {}),
            ...(control.author ? { author: control.author } : {}),
          }),
          parts: buildUserPromptParts(sessionId, control.userMessageId, control.parts),
        }
      : undefined,
    assistant: buildAssistantMessage({
      id: control.assistantMessageId,
      sessionID: sessionId,
      parentID: control.userMessageId ?? control.parentMessageId ?? sessionId,
      agent: control.agent,
      model: control.model,
      directory: input.directory,
      created: ts,
    }),
  }
}
