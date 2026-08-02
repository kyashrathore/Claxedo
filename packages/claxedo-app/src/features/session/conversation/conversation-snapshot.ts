import type { UIMessage } from "@tanstack/ai"

export function compactConversationSnapshot(messages: UIMessage[] | undefined) {
  if (!messages) return messages
  const byId = new Map<string, UIMessage>()
  for (const message of messages) byId.set(message.id, message)
  return byId.size === messages.length ? messages : [...byId.values()]
}
