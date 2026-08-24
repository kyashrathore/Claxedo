import type { SessionPrefetchMeta } from "@/platform/sync/session-prefetch"
import { splitSessionPrefetchPage } from "@/platform/sync/session-prefetch"
import { hydrateConversationPage } from "../conversation/conversation-hydrator"
import { registeredConversationSnapshot } from "../conversation/conversation-registry"
import type { ConversationDirectory } from "../conversation/conversation-chat-client"

/** Always apply the bounded surface; matching message ids do not prove its text parts are present. */
export function hydrateFirstFoldSessionPrefetch(input: {
  directory: ConversationDirectory
  sessionID: string
  prefetch: SessionPrefetchMeta
}) {
  const split = splitSessionPrefetchPage(input.prefetch)
  if (!split) return
  const conversation = registeredConversationSnapshot(input.directory, input.sessionID)
  hydrateConversationPage({
    directory: input.directory,
    sessionID: input.sessionID,
    messages: split.firstFold.messages,
    parts: split.firstFold.parts.map((row) => ({ id: row.id, parts: row.part })),
    messageCompleteness: "fragment",
    partCompleteness: "fragment",
    ...(conversation.messages.length > 0 ? { mode: "prepend" as const } : {}),
  })
  return split
}
