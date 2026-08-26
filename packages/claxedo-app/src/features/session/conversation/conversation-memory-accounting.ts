import type { UIMessage } from "@tanstack/ai"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { estimateConversationMemory } from "./conversation-memory"

/**
 * Pure measurement memo keyed by the canonical cached snapshot identity.
 * Authority remains in the conversation writer; dropping that snapshot also
 * makes this entry collectible without a parallel cleanup path.
 */
const conversationBytesMemo = new WeakMap<object, { at: number; bytes: number }>()

export function cachedConversationBytes(sessionID: string, options?: { allowStale?: boolean }) {
  return queryClient.getQueryCache().findAll({
    queryKey: shellDataKeys.sessionId(sessionID, "conversation"),
  }).reduce((total, query) => {
    const messages = query.state.data as UIMessage[] | undefined
    if (!messages) return total
    return total + measuredConversationBytes(messages, query.state.dataUpdatedAt, options)
  }, 0)
}

function measuredConversationBytes(messages: UIMessage[], at: number, options?: { allowStale?: boolean }) {
  const memo = conversationBytesMemo.get(messages)
  if (memo && (options?.allowStale || memo.at === at)) return memo.bytes
  const bytes = estimateConversationMemory(messages).totalBytes
  conversationBytesMemo.set(messages, { at, bytes })
  return bytes
}
