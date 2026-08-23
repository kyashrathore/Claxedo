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
import { estimateConversationMemory } from "./conversation-memory"

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

/**
 * Memo table for {@link cachedConversationBytes}, keyed on the snapshot array
 * itself. Not module state in the sense the architecture ratchet guards: it
 * carries no authority and nothing reads it for truth — every entry is a pure
 * function of its own key, so it cannot drift, and a dropped transcript takes
 * its entry with it rather than needing a cleanup path.
 */
const conversationBytesMemo = new WeakMap<object, { at: number; bytes: number }>()

/**
 * Estimated payload bytes of a session's cached transcript, for the memory
 * ceiling that bounds total retained conversation size.
 *
 * `estimateConversationMemory` is a deep walk over every message, part and
 * string — proportional to the very bytes it is counting. The ceiling runs on
 * every session hydration and must consider every cached session, so walking
 * each one every time would make switching sessions cost O(all retained bytes).
 *
 * Validated on BOTH the array's identity and the query's `dataUpdatedAt`,
 * because neither alone is sufficient: `compactConversationSnapshot` returns the
 * caller's array untouched when there is nothing to dedupe, so a transcript can
 * grow behind a stable reference, while a rewrite with identical content bumps
 * the timestamp without changing anything. Either signal moving re-walks; only
 * a genuinely untouched transcript is served from the memo.
 *
 * `allowStale` serves the last measurement for a session the caller has already
 * decided it cannot evict. A streaming transcript changes on every delta, so it
 * would otherwise miss the memo on every single pass — putting a full re-walk
 * (~2 ms per MB) on the session-switch path in exchange for refining a number
 * that cannot change the outcome. A never-measured session is still walked.
 */
export function cachedConversationBytes(sessionID: string, options?: { allowStale?: boolean }) {
  const query = queryClient.getQueryCache().find({ queryKey: conversationSnapshotKey(sessionID) })
  const messages = query?.state.data as UIMessage[] | undefined
  if (!messages) return 0
  const at = query?.state.dataUpdatedAt ?? 0
  const memo = conversationBytesMemo.get(messages)
  if (memo && (options?.allowStale || memo.at === at)) return memo.bytes
  const bytes = estimateConversationMemory(messages).totalBytes
  conversationBytesMemo.set(messages, { at, bytes })
  return bytes
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
  return memoizeSuccessfulLoad(() => retry(load, {
    attempts: Number.MAX_SAFE_INTEGER,
    delay: options.delay ?? 250,
    factor: 2,
    maxDelay: options.maxDelay ?? 30_000,
    retryIf: () => true,
  }))
}

const loadChatClientRuntime = recoveringChatClientRuntime(() =>
  Promise.all([
    import("@tanstack/ai-client"),
    import("@tanstack/ai/client"),
  ]).then(([clientModule, aiClientModule]) => ({
    ChatClient: clientModule.ChatClient,
    EventType: aiClientModule.EventType,
  })),
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
  sessionID: string,
  options: { loadRuntime?: () => Promise<ChatClientRuntime> } = {},
): ConversationChatEntry {
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
  const ready = (options.loadRuntime ?? loadChatClientRuntime)().then((runtime) => {
    client = new runtime.ChatClient({
      id: sessionID,
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
        client.setMessagesManually(compacted)
        return
      }
      buffered = compacted
      onMessagesChange(compacted)
    },
  }
  return { sessionID, ready, version, handle, refs: 0 }
}
