import type { Workspace } from "../workspace-store"
import type { SessionAttachment, SessionMeta } from "../session-meta"
import type { SyncDB } from "../sync-db"

export type ProjectionStore = {
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
  read_session_messages: (sessionID: string) => Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
}

export function createProjectionStore(sync: SyncDB): ProjectionStore {
  return {
    sync_session_meta: sync.sync_session_meta,
    sync_session_metas: sync.sync_session_metas,
    put_session_meta: sync.put_session_meta,
    delete_session_meta: sync.delete_session_meta,
    session_meta: sync.session_meta,
    session_metas: sync.session_metas,
    list_session_metas: sync.list_session_metas,
    tagged_session_metas: sync.tagged_session_metas,
    read_session_messages: sync.read_session_messages,
  }
}
