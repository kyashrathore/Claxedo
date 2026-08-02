import {
  claimChannelDelivery,
  countChannelDeliveriesByUserDay,
  rememberChannelDeliverySession,
  releaseChannelDelivery,
} from "../../../channels/delivery"
import {
  channelThreadSession,
  channelRunAudit,
  channelRunAudits,
  clearChannelThreadSession,
  recordChannelRunAudit,
} from "../../../channels/run-audit"
import {
  deleteSessionMeta,
  listSessionMetas,
  listSessionNavigationMetas,
  putSessionMeta,
  sessionMeta,
  sessionMetas,
  syncSessionMeta,
  syncSessionMetas,
  sourceChannelSessionCountsByWeek,
  taggedSessionMetas,
} from "../../../session/meta/meta"
import {
  persistMessageEvent,
  readSessionMessages,
  readSessionMaxEventOrdinal,
  subscribeMessageReplay,
} from "../../../cloud/message-replay"
import { syncCloudMessages } from "../../../cloud/session-sync"
import type { SessionWriteMode } from "../../../architecture"

import { createDurableSessionLog, type DurableSessionLog, type DurableSessionLogBackend } from "../../durable-session-log"
import { createProjectionStore, type ProjectionStore, type ProjectionStoreBackend } from "../../projection-store"

// Claxedo's LOCAL central-store adapter: the control plane's central
// persistence (session-meta projections, message replay log, channel
// delivery/audit) backed by the local SQLite storage modules. The core seam is
// the PORTS (ProjectionStore, DurableSessionLog) — this adapter is one way to
// produce them. Hosted/Worker compositions produce the ports differently and
// must never import this module (worker.import-graph guard).
//
// The backend contract is the port contracts themselves (plus the write-mode
// probe) — deriving it keeps this adapter in lockstep when a port gains a field.
type SqliteCentralStoreBackend = ProjectionStoreBackend & DurableSessionLogBackend & { mode: () => SessionWriteMode }

export type SqliteCentralStoreOptions = {
  mode: () => SessionWriteMode
}

function createBackend(input: SqliteCentralStoreOptions): SqliteCentralStoreBackend {
  return {
    mode: input.mode,
    sync_session_meta: syncSessionMeta,
    sync_session_metas: syncSessionMetas,
    sync_session_messages: (ws, sessionID, value, options) =>
      ws ? syncCloudMessages(ws, sessionID, value, options) : Promise.resolve(),
    put_session_meta: putSessionMeta,
    delete_session_meta: deleteSessionMeta,
    session_meta: sessionMeta,
    session_metas: sessionMetas,
    list_session_metas: listSessionMetas,
    list_session_navigation_metas: listSessionNavigationMetas,
    tagged_session_metas: taggedSessionMetas,
    source_channel_session_counts_by_week: sourceChannelSessionCountsByWeek,
    claim_channel_delivery: claimChannelDelivery,
    remember_channel_delivery_session: rememberChannelDeliverySession,
    release_channel_delivery: releaseChannelDelivery,
    count_channel_deliveries_by_user_day: countChannelDeliveriesByUserDay,
    record_channel_run_audit: recordChannelRunAudit,
    channel_run_audit: channelRunAudit,
    channel_run_audits: channelRunAudits,
    channel_thread_session: channelThreadSession,
    clear_channel_thread_session: clearChannelThreadSession,
    persist_message_event: persistMessageEvent,
    read_session_messages: readSessionMessages,
    read_session_max_event_ordinal: readSessionMaxEventOrdinal,
    subscribe_message_replay: subscribeMessageReplay,
  }
}

export type SqliteCentralStore = {
  projectionStore: ProjectionStore
  durableSessionLog: DurableSessionLog
  sessionWriteMode: () => SessionWriteMode
}

export function createSqliteCentralStore(input: SqliteCentralStoreOptions): SqliteCentralStore {
  const backend = createBackend(input)
  return {
    projectionStore: createProjectionStore(backend),
    durableSessionLog: createDurableSessionLog(backend),
    sessionWriteMode: backend.mode,
  }
}
