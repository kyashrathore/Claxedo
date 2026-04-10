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
  deleteCloudSession,
  syncCloudMessages,
  syncCloudSession,
  syncCloudSessions,
} from "./cloud/session-sync"
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
  sync_cloud_session: (ws: Workspace, input: unknown) => Promise<void>
  sync_cloud_sessions: (ws: Workspace, input: unknown[]) => Promise<void>
  delete_cloud_session: (ws: Workspace, sessionID: string) => Promise<void>
  sync_cloud_messages: (ws: Workspace, sessionID: string, input: unknown[]) => Promise<void>
  persist_message_event: (sessionID: string, event: { type: string; properties?: unknown }) => void
  read_session_messages: (sessionID: string) => Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  subscribe_message_replay: (bus: {
    subscribe: (fn: (event: { directory?: string; payload: { type: string; properties?: Record<string, unknown> } }) => void) => () => void
  }) => () => void
}

type Input = {
  mode: () => SessionWriteMode
}

export function createSyncDB(input: Input): SyncDB {
  return {
    mode: input.mode,
    sync_session_meta: syncSessionMeta,
    sync_session_metas: syncSessionMetas,
    put_session_meta: putSessionMeta,
    delete_session_meta: deleteSessionMeta,
    session_meta: sessionMeta,
    session_metas: sessionMetas,
    list_session_metas: listSessionMetas,
    tagged_session_metas: taggedSessionMetas,
    sync_cloud_session: syncCloudSession,
    sync_cloud_sessions: syncCloudSessions,
    delete_cloud_session: deleteCloudSession,
    sync_cloud_messages: syncCloudMessages,
    persist_message_event: persistMessageEvent,
    read_session_messages: readSessionMessages,
    subscribe_message_replay: subscribeMessageReplay,
  }
}
