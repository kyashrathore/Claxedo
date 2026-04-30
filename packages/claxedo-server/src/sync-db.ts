import type { Workspace } from "./workspace-store"
import {
  deleteSessionMeta,
  listSessionMetas,
  putSessionMeta,
  sessionMeta,
  sessionMetas,
  syncSessionMeta,
  syncSessionMetas,
  taggedSessionMetas,
  type SessionAttachment,
  type SessionMeta,
} from "./session-meta"
import {
  persistMessageEvent,
  readSessionMessages,
  subscribeMessageReplay,
} from "./cloud/message-replay"
import type { SessionWriteMode } from "./architecture"

export type SyncDB = {
  mode: () => SessionWriteMode
  sync_session_meta: (ws: Workspace | undefined, input: unknown) => Promise<void>
  sync_session_metas: (ws: Workspace | undefined, input: unknown[]) => Promise<void>
  put_session_meta: (
    sessionID: string,
    input: {
      ws?: Workspace
      directory?: string | null
      title?: string | null
      parentID?: string | null
      archived?: number | null
      tags?: string[]
      attachments?: SessionAttachment[]
    },
  ) => Promise<void>
  delete_session_meta: (sessionID: string) => Promise<void>
  session_meta: (sessionID: string) => Promise<SessionMeta | undefined>
  session_metas: (input: string[]) => Promise<Map<string, SessionMeta>>
  list_session_metas: (input?: {
    workspaceID?: string
    directory?: string
    includeArchived?: boolean
  }) => Promise<SessionMeta[]>
  tagged_session_metas: (tags: string[], input?: { includeHidden?: boolean }) => Promise<SessionMeta[]>
  persist_message_event: (sessionID: string, event: { type: string; properties?: unknown }) => void
  read_session_messages: (sessionID: string) => Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  subscribe_message_replay: (bus: {
    subscribe: (fn: (event: { directory?: string; payload: { type: string; properties?: Record<string, unknown> } }) => void) => () => void
  }) => () => void
}

type Input = {
  mode: () => SessionWriteMode
}

async function safeAsync<T>(label: string, fallback: T, run: () => Promise<T>) {
  try {
    return await run()
  } catch (error) {
    console.warn(`[sync-db] ${label} unavailable`, error)
    return fallback
  }
}

function safeSync<T>(label: string, fallback: T, run: () => T) {
  try {
    return run()
  } catch (error) {
    console.warn(`[sync-db] ${label} unavailable`, error)
    return fallback
  }
}

export function createSyncDB(input: Input): SyncDB {
  return {
    mode: input.mode,
    sync_session_meta: (ws, value) => safeAsync("sync_session_meta", undefined, () => syncSessionMeta(ws, value)),
    sync_session_metas: (ws, value) => safeAsync("sync_session_metas", undefined, () => syncSessionMetas(ws, value)),
    put_session_meta: (sessionID, value) => safeAsync("put_session_meta", undefined, () => putSessionMeta(sessionID, value)),
    delete_session_meta: (sessionID) => safeAsync("delete_session_meta", undefined, () => deleteSessionMeta(sessionID)),
    session_meta: (sessionID) => safeAsync("session_meta", undefined, () => sessionMeta(sessionID)),
    session_metas: (value) => safeAsync("session_metas", new Map(), () => sessionMetas(value)),
    list_session_metas: (value) => safeAsync("list_session_metas", [], () => listSessionMetas(value)),
    tagged_session_metas: (tags, value) => safeAsync("tagged_session_metas", [], () => taggedSessionMetas(tags, value)),
    persist_message_event: (sessionID, event) => {
      safeSync("persist_message_event", undefined, () => persistMessageEvent(sessionID, event))
    },
    read_session_messages: (sessionID) => safeSync("read_session_messages", [], () => readSessionMessages(sessionID)),
    subscribe_message_replay: (bus) => safeSync("subscribe_message_replay", () => {}, () => subscribeMessageReplay(bus)),
  }
}
