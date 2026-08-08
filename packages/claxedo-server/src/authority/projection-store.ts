import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { SessionAttachment, SessionMeta, SessionMetaNavigationListInput, SessionToolSandbox } from "@claxedo/server-core/session/meta/index"
import type { ChannelDeliveryClaimInput, ChannelDeliveryDecision } from "../channels/delivery"
import type { ChannelRunAuditInput, ChannelRunAuditRecord } from "../channels/run-audit"

export type ProjectionStore = {
  sync_session_meta: (ws: Workspace | undefined, input: unknown) => Promise<void>
  sync_session_metas: (ws: Workspace | undefined, input: unknown[]) => Promise<void>
  sync_session_messages: (
    ws: Workspace | undefined,
    sessionID: string,
    messages: unknown[],
    options?: { maxEventOrdinal?: number },
  ) => Promise<void>
  put_session_meta: (
    sessionID: string,
    input: {
      ws?: Workspace
      workspaceID?: string | null
      directory?: string | null
      host?: "central" | "workspace"
      toolSandbox?: SessionToolSandbox | null
      model?: { providerID: string; modelID: string } | null
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
  list_session_navigation_metas?: (input: SessionMetaNavigationListInput) => Promise<SessionMeta[]>
  tagged_session_metas: (tags: string[], input?: { includeHidden?: boolean }) => Promise<SessionMeta[]>
  source_channel_session_counts_by_week?: (input?: {
    channel?: string
    includeHidden?: boolean
  }) => Promise<Array<{ channel: string; week: string; count: number }>>
  claim_channel_delivery?: (input: ChannelDeliveryClaimInput) => Promise<ChannelDeliveryDecision>
  remember_channel_delivery_session?: (input: { channel: string; idempotencyKey: string; sessionId: string; sessionCreate?: boolean }) => Promise<void>
  release_channel_delivery?: (input: { channel: string; idempotencyKey: string }) => Promise<void>
  count_channel_deliveries_by_user_day?: (input: { channel: string; externalUserId: string; day: string }) => Promise<number>
  record_channel_run_audit?: (input: ChannelRunAuditInput) => Promise<void>
  channel_run_audit?: (input: { sessionId: string }) => Promise<ChannelRunAuditRecord | undefined>
  channel_run_audits?: (input?: { channel?: string; externalUserId?: string; threadKey?: string; workspaceId?: string }) => Promise<ChannelRunAuditRecord[]>
  channel_thread_session?: (input: { threadKey: string }) => Promise<string | undefined>
  clear_channel_thread_session?: (input: { threadKey: string; sessionId?: string }) => Promise<void>
  read_session_messages: (sessionID: string) => Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  read_session_max_event_ordinal: (sessionID: string) => number
}

// The backend contract this port needs — adapters (e.g. the SQLite
// central-store) supply any object with these methods.
export type ProjectionStoreBackend = ProjectionStore

export function createProjectionStore(sync: ProjectionStoreBackend): ProjectionStore {
  return {
    sync_session_meta: sync.sync_session_meta,
    sync_session_metas: sync.sync_session_metas,
    sync_session_messages: sync.sync_session_messages,
    put_session_meta: sync.put_session_meta,
    delete_session_meta: sync.delete_session_meta,
    session_meta: sync.session_meta,
    session_metas: sync.session_metas,
    list_session_metas: sync.list_session_metas,
    list_session_navigation_metas: sync.list_session_navigation_metas,
    tagged_session_metas: sync.tagged_session_metas,
    source_channel_session_counts_by_week: (input) => sync.source_channel_session_counts_by_week?.(input) ?? Promise.resolve([]),
    claim_channel_delivery: sync.claim_channel_delivery,
    remember_channel_delivery_session: sync.remember_channel_delivery_session,
    release_channel_delivery: sync.release_channel_delivery,
    count_channel_deliveries_by_user_day: sync.count_channel_deliveries_by_user_day,
    record_channel_run_audit: sync.record_channel_run_audit,
    channel_run_audit: sync.channel_run_audit,
    channel_run_audits: sync.channel_run_audits,
    channel_thread_session: sync.channel_thread_session,
    clear_channel_thread_session: sync.clear_channel_thread_session,
    read_session_messages: sync.read_session_messages,
    read_session_max_event_ordinal: sync.read_session_max_event_ordinal,
  }
}
