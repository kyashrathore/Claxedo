import { registeredConversationSnapshot } from "../conversation/conversation-registry"
import type { ConversationDirectory } from "../conversation/conversation-chat-client"

/**
 * Whether the announced assistant reply has produced content or an error.
 *
 * The runtime may announce `${userMessageId}_r` and later emit the reply under
 * an engine-selected id. Matching the parent preserves that turn identity, but
 * only a non-tool-call finish is terminal: intermediate tool steps share the
 * same parent and also receive completed timestamps.
 */
export function conversationHasAssistantMessage(directory: ConversationDirectory, sessionID: string, assistantMessageId: string | undefined) {
  if (!assistantMessageId) return false
  const conversation = registeredConversationSnapshot(directory, sessionID)
  const userMessageId = assistantMessageId.endsWith("_r") ? assistantMessageId.slice(0, -2) : undefined
  const turnFinished = (item: (typeof conversation.messages)[number]) => {
    if ("error" in item && item.error) return true
    const finish = (item as { finish?: unknown }).finish
    return typeof finish === "string" && finish !== "tool-calls"
  }
  const message = conversation.messages.find(
    (item) =>
      item.role === "assistant" &&
      (item.id === assistantMessageId ||
        (!!userMessageId && item.parentID === userMessageId && turnFinished(item))),
  )
  if (!message) return false
  return "error" in message && !!message.error || (conversation.parts[message.id]?.length ?? 0) > 0
}
