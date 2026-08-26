import { createSignal, type Accessor } from "solid-js"
import type { ChatClient } from "@tanstack/ai-client"
import type { ConnectConnectionAdapter } from "@tanstack/ai-solid"
import type { EventType, StreamChunk } from "@tanstack/ai/client"
import type { UIMessage } from "@tanstack/ai"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { memoizeSuccessfulLoad, retry } from "@/lib/retry"
import type { ConversationChatHandle } from "./opencode-conversation"
import { conversationPersistence } from "./conversation-persistence"
import { compactConversationSnapshot } from "./conversation-snapshot"
import { scheduleSessionCacheCeiling } from "../data/sync/session-cache-cleanup"

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
export type ConversationDirectory = string

export type ConversationChatEntry = {
  directory: ConversationDirectory
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

export type ConversationScope = {
  directory: ConversationDirectory
  sessionID: string
}

export function conversationScopeKey(scope: ConversationScope) {
  return `${scope.directory}\0${scope.sessionID}`
}

export function conversationSnapshotKey(scope: ConversationScope) {
  return shellDataKeys.sessionId(scope.sessionID, "conversation", scope.directory)
}

export function readConversationSnapshot(scope: ConversationScope) {
  return compactConversationSnapshot(queryClient.getQueryData<UIMessage[]>(conversationSnapshotKey(scope)))
}

export function writeConversationSnapshot(scope: ConversationScope, snapshot: UIMessage[]) {
  const key = conversationSnapshotKey(scope)
  const previous = queryClient.getQueryData<UIMessage[]>(key)
  const stored = queryClient.setQueryData(key, compactConversationSnapshot(snapshot) ?? [])
  if (stored === previous) return false
  scheduleSessionCacheCeiling(scope.sessionID)
  return true
}

// Lazy boundary for the ai-client runtime (ChatClient body + SSE→parts stream
// processor, ~22-28 KB gz). Kicked off on first entry construction; memoized so
// every session shares one in-flight or successful load. A rejected chunk load
// is cleared so constructing a later entry can recover without a page reload.
export type ChatClientRuntime = {
  ChatClient: typeof ChatClient
  EventType: typeof EventType
}

export function recoveringChatClientRuntime(
  load: () => Promise<ChatClientRuntime>,
  options: { delay?: number; maxDelay?: number } = {},
) {
  return memoizeSuccessfulLoad(() =>
    retry(load, {
      attempts: Number.MAX_SAFE_INTEGER,
      delay: options.delay ?? 250,
      factor: 2,
      maxDelay: options.maxDelay ?? 30_000,
      retryIf: () => true,
    }),
  )
}

const loadChatClientRuntime = recoveringChatClientRuntime(() =>
  Promise.all([import("@tanstack/ai-client"), import("@tanstack/ai/client")]).then(
    ([clientModule, aiClientModule]) => ({
      ChatClient: clientModule.ChatClient,
      EventType: aiClientModule.EventType,
    }),
  ),
)

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

export function createConversationChatClient(
  scope: ConversationScope,
  options: { loadRuntime?: () => Promise<ChatClientRuntime> } = {},
): ConversationChatEntry {
  const [version, setVersion] = createSignal(0)
  let manualMutation = false
  const onMessagesChange = (messages: UIMessage[]) => {
    // Keep the sync working copy (query-cache reads + reactivity); IDB
    // durability is handled by the persistence adapter (real client only).
    if (writeConversationSnapshot(scope, messages) && !manualMutation) setVersion((value) => value + 1)
  }
  // Sync seed from the query cache (instant within a tab session). This buffer
  // backs the entry only until the lazily-imported ChatClient constructs; the
  // IDB persistence adapter then async-hydrates so the conversation survives a
  // full reload (race-guarded against newer messages by ChatClient).
  let buffered = readConversationSnapshot(scope) ?? []
  let client: ChatClient | undefined
  const ready = (options.loadRuntime ?? loadChatClientRuntime)().then((runtime) => {
    client = new runtime.ChatClient({
      id: conversationScopeKey(scope),
      initialMessages: buffered,
      connection: noopConnection,
      persistence: conversationPersistence,
      onMessagesChange,
    })
  })
  // Production keeps retrying until the shared lazy chunk becomes available;
  // observe the promise as a final safeguard so a custom/test loader cannot
  // create an unhandled rejection while the synchronous buffer remains live.
  void ready.catch(() => undefined)
  const handle: ConversationChatHandle = {
    messages: () => (client ? client.getMessages() : buffered),
    setMessages: (messages) => {
      const compacted = compactConversationSnapshot(messages) ?? []
      if (client) {
        manualMutation = true
        try {
          client.setMessagesManually(compacted)
        } finally {
          manualMutation = false
        }
        // TanStack currently mutates its manual buffer without guaranteeing
        // `onMessagesChange`. The registry is the canonical writer, so publish
        // that completed mutation here and bump exactly once. `manualMutation`
        // suppresses a synchronous callback bump if a future client version
        // starts invoking the callback for this method.
        writeConversationSnapshot(scope, client.getMessages())
        setVersion((value) => value + 1)
        return
      }
      buffered = compacted
      onMessagesChange(compacted)
    },
  }
  return { ...scope, ready, version, handle, refs: 0 }
}
