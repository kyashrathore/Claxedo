import { readField } from "@/lib/record"
import { registeredConversationSnapshot } from "../conversation/conversation-registry"
import { isRuntimeAgentMessage } from "../conversation/agent-conversation-codec"
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
    const finish = readField(item, "finish")
    return typeof finish === "string" && finish !== "tool-calls"
  }
  // Only a runtime-produced row carries the `parentID`/`error` this reads; an
  // optimistic local stub is by definition not evidence that the reply landed.
  const message = conversation.messages.find(
    (item) =>
      isRuntimeAgentMessage(item) &&
      item.role === "assistant" &&
      (item.id === assistantMessageId ||
        (!!userMessageId && item.parentID === userMessageId && turnFinished(item))),
  )
  if (!message) return false
  return "error" in message && !!message.error || (conversation.parts[message.id]?.length ?? 0) > 0
}

/**
 * Whether the owner has produced any assistant row for this turn.
 *
 * Weaker than `conversationHasAssistantMessage` on purpose, and for a different
 * question. That one asks whether a turn has settled, which needs a finish the
 * reply carries. This asks whether the owner answered the turn at all, which is
 * what decides whether a reopened range still owes coverage for it: a turn with
 * a reply in the transcript is at worst incomplete, and the ordinary history
 * read owns that. A turn with nothing is the one whose obligation was lost.
 */
export function conversationHasTurnReply(directory: ConversationDirectory, sessionID: string, userMessageId: string) {
  const conversation = registeredConversationSnapshot(directory, sessionID)
  return conversation.messages.some(
    (item) => isRuntimeAgentMessage(item) && item.role === "assistant" && item.parentID === userMessageId,
  )
}
