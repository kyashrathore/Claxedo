import { createSignal, type Accessor } from "solid-js"
import { ChatClient } from "@tanstack/ai-client"
import type { ConnectConnectionAdapter } from "@tanstack/ai-solid"
import { EventType, type StreamChunk } from "@tanstack/ai/client"
import type { UIMessage } from "@tanstack/ai"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import type { ConversationChatHandle } from "./opencode-conversation"
import { conversationPersistence } from "./conversation-persistence"
import { compactConversationSnapshot } from "./conversation-snapshot"

/**
 * One canonical conversation store per session: a registry-owned TanStack
 * `ChatClient` keyed by `sessionId`. The client owns the message array; the
 * query cache is its durable backing (rehydrate on construct via
 * `initialMessages`, persist on every change via `onMessagesChange`), so the
 * conversation survives unmount/remount and stays readable synchronously.
 */
export type ConversationChatEntry = {
  sessionID: string
  client: ChatClient
  /** Per-session reactivity. Bumps whenever this session's messages change. */
  version: Accessor<number>
  /** `{messages,setMessages}` adapter so `opencode-conversation.ts` is unchanged. */
  handle: ConversationChatHandle
  /** Mount refcount; the client outlives any single mount (see owner cleanup). */
  refs: number
  /** Teardown for the live SSE side-channel (wired in W1-P3). */
  unsubscribe?: () => void
}

export function conversationSnapshotKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, "conversation")
}

export function readConversationSnapshot(sessionID: string) {
  return compactConversationSnapshot(queryClient.getQueryData<UIMessage[]>(conversationSnapshotKey(sessionID)))
}

export function writeConversationSnapshot(sessionID: string, snapshot: UIMessage[]) {
  queryClient.setQueryData(conversationSnapshotKey(sessionID), compactConversationSnapshot(snapshot) ?? [])
}

// Placeholder transport until the subscribe-mode claxedo adapter lands (W1-P3).
// The live event path still flows through `applyRegisteredConversationEvent`,
// so this connection is never the source of streamed messages today.
const noopConnection: ConnectConnectionAdapter = {
  async *connect(_messages, _data, _abortSignal, runContext) {
    yield {
      type: EventType.RUN_FINISHED,
      threadId: runContext?.threadId ?? "claxedo",
      runId: runContext?.runId ?? "noop",
      finishReason: "stop",
    } as StreamChunk
  },
}

export function createConversationChatClient(sessionID: string): ConversationChatEntry {
  const [version, setVersion] = createSignal(0)
  const client = new ChatClient({
    id: sessionID,
    // Sync seed from the query cache (instant within a tab session). The IDB
    // persistence adapter additionally async-hydrates on construct so the
    // conversation survives a full reload (it is race-guarded against newer
    // messages by ChatClient).
    initialMessages: readConversationSnapshot(sessionID) ?? [],
    connection: noopConnection,
    persistence: conversationPersistence,
    onMessagesChange: (messages) => {
      // Keep the sync working copy (query-cache reads + reactivity); IDB
      // durability is handled by the persistence adapter above.
      writeConversationSnapshot(sessionID, messages)
      setVersion((value) => value + 1)
    },
  })
  const handle: ConversationChatHandle = {
    messages: () => client.getMessages(),
    setMessages: (messages) => client.setMessagesManually(compactConversationSnapshot(messages) ?? []),
  }
  return { sessionID, client, version, handle, refs: 0 }
}
