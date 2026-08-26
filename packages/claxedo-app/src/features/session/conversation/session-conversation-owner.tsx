import { createTrackedEffect, onCleanup, type Accessor } from "solid-js"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { hydrateRegisteredConversationSnapshot, registerSessionConversationChat } from "./conversation-registry"

/**
 * Keeps a session's canonical conversation store alive while mounted and feeds
 * it the upstream OpenCode snapshot. The registry owns the one `ChatClient`
 * (see conversation-registry.ts); this component holds a mount reference and
 * hydrates from `props.messages`/`props.parts`. It owns no conversation state
 * itself — no per-mount chat hook is created here.
 */
export function SessionConversationOwner(props: {
  sessionId: string
  messages: Accessor<Message[] | undefined>
  parts: (messageID: string) => Part[] | undefined
}) {
  onCleanup(registerSessionConversationChat(props.sessionId))
  createTrackedEffect(() => {
    const messages = props.messages() ?? []
    if (messages.length === 0) return
    hydrateRegisteredConversationSnapshot({
      sessionID: props.sessionId,
      messages,
      parts: Object.fromEntries(messages.map((message) => [message.id, props.parts(message.id)])),
    })
  })
  return null
}
