import { createEffect, onCleanup, type Accessor } from "solid-js"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { hydrateRegisteredConversationSnapshot, registerSessionConversationChat } from "./conversation-registry"
import type { ConversationDirectory } from "./conversation-chat-client"

/**
 * Keeps a session's canonical conversation store alive while mounted and feeds
 * it the upstream OpenCode snapshot. The registry owns the one `ChatClient`
 * (see conversation-registry.ts); this component holds a mount reference and
 * hydrates from `props.messages`/`props.parts`. It owns no conversation state
 * itself — no per-mount chat hook is created here.
 */
export function SessionConversationOwner(props: {
  directory: ConversationDirectory
  sessionId: string
  messages: Accessor<Message[] | undefined>
  parts: (messageID: string) => Part[] | undefined
}) {
  onCleanup(registerSessionConversationChat({ directory: props.directory, sessionID: props.sessionId }))
  // `props.parts` is read in the compute: part streaming is exactly what has to
  // re-hydrate the store. The session id is not — it only labels the snapshot,
  // and the mount-time registration above already pins it. The directory does
  // scope the store, so it stays tracked.
  createEffect(
    () => {
      const messages = props.messages() ?? []
      if (messages.length === 0) return
      return {
        directory: props.directory,
        messages,
        parts: Object.fromEntries(messages.map((message) => [message.id, props.parts(message.id)])),
      }
    },
    (snapshot) => {
      if (!snapshot) return
      hydrateRegisteredConversationSnapshot({ sessionID: props.sessionId, ...snapshot })
    },
  )
  return null
}
