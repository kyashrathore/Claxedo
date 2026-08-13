import { createSignal, type Accessor } from "solid-js"
import type { ChatClient } from "@tanstack/ai-client"
import type { ConnectConnectionAdapter } from "@tanstack/ai-solid"
import type { EventType, StreamChunk } from "@tanstack/ai/client"
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
 *
 * The `@tanstack/ai-client` runtime is deliberately NOT on the eager boot
 * chunk (see scripts/forbidden-eager-deps.config.ts). Each entry starts on a
 * synchronous query-cache-backed buffer and swaps to the real `ChatClient`
 * once the lazily-imported module resolves; `entry.ready` settles at the swap.
 */
export type ConversationChatEntry = {
  sessionID: string
  /** Resolves once the lazily-loaded `ChatClient` backs this entry. */
  ready: Promise<void>
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

// Lazy boundary for the ai-client runtime (ChatClient body + SSE→parts stream
// processor, ~22-28 KB gz). Kicked off on first entry construction; memoized so
// every session shares one in-flight load.
type ChatClientRuntime = {
  ChatClient: typeof ChatClient
  EventType: typeof EventType
}

let chatClientRuntime: Promise<ChatClientRuntime> | undefined

function loadChatClientRuntime() {
  chatClientRuntime ??= Promise.all([
    import("@tanstack/ai-client"),
    import("@tanstack/ai/client"),
  ]).then(([clientModule, aiClientModule]) => ({
    ChatClient: clientModule.ChatClient,
    EventType: aiClientModule.EventType,
  }))
  return chatClientRuntime
}

// Placeholder transport until the subscribe-mode claxedo adapter lands (W1-P3).
// The live event path still flows through `applyRegisteredConversationEvent`,
// so this connection is never the source of streamed messages today. Only a
// constructed ChatClient can invoke it, so the runtime await below is settled.
const noopConnection: ConnectConnectionAdapter = {
  async *connect(_messages, _data, _abortSignal, runContext) {
    const runtime = await loadChatClientRuntime()
    yield {
      type: runtime.EventType.RUN_FINISHED,
      threadId: runContext?.threadId ?? "claxedo",
      runId: runContext?.runId ?? "noop",
      finishReason: "stop",
    } as StreamChunk
  },
}

export function createConversationChatClient(sessionID: string): ConversationChatEntry {
  const [version, setVersion] = createSignal(0)
  const onMessagesChange = (messages: UIMessage[]) => {
    // Keep the sync working copy (query-cache reads + reactivity); IDB
    // durability is handled by the persistence adapter (real client only).
    writeConversationSnapshot(sessionID, messages)
    setVersion((value) => value + 1)
  }
  // Sync seed from the query cache (instant within a tab session). This buffer
  // backs the entry only until the lazily-imported ChatClient constructs; the
  // IDB persistence adapter then async-hydrates so the conversation survives a
  // full reload (race-guarded against newer messages by ChatClient).
  let buffered = readConversationSnapshot(sessionID) ?? []
  let client: ChatClient | undefined
  const ready = loadChatClientRuntime().then((runtime) => {
    client = new runtime.ChatClient({
      id: sessionID,
      initialMessages: buffered,
      connection: noopConnection,
      persistence: conversationPersistence,
      onMessagesChange,
    })
  })
  const handle: ConversationChatHandle = {
    messages: () => (client ? client.getMessages() : buffered),
    setMessages: (messages) => {
      const compacted = compactConversationSnapshot(messages) ?? []
      if (client) {
        client.setMessagesManually(compacted)
        return
      }
      buffered = compacted
      onMessagesChange(compacted)
    },
  }
  return { sessionID, ready, version, handle, refs: 0 }
}
