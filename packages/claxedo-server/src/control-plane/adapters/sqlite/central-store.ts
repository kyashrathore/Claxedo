import {
  claimChannelDelivery,
  countChannelDeliveriesByUserDay,
  rememberChannelDeliverySession,
  releaseChannelDelivery,
} from "../../../channel-delivery"
import {
  channelRunAudit,
  channelRunAudits,
  recordChannelRunAudit,
} from "../../../channel-run-audit"
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
} from "../../../session-meta"
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

async function safeAsync<T>(label: string, fallback: T, run: () => Promise<T>) {
  try {
    return await run()
  } catch (error) {
    console.warn(`[central-store] ${label} unavailable`, error)
    return fallback
  }
}

function safeSync<T>(label: string, fallback: T, run: () => T) {
  try {
    return run()
  } catch (error) {
    console.warn(`[central-store] ${label} unavailable`, error)
    return fallback
  }
}

function createBackend(input: SqliteCentralStoreOptions): SqliteCentralStoreBackend {
  return {
    mode: input.mode,
    sync_session_meta: (ws, value) => safeAsync("sync_session_meta", undefined, () => syncSessionMeta(ws, value)),
    sync_session_metas: (ws, value) => safeAsync("sync_session_metas", undefined, () => syncSessionMetas(ws, value)),
    sync_session_messages: (ws, sessionID, value, options) =>
      safeAsync("sync_session_messages", undefined, () => ws ? syncCloudMessages(ws, sessionID, value, options) : Promise.resolve()),
    put_session_meta: (sessionID, value) => safeAsync("put_session_meta", undefined, () => putSessionMeta(sessionID, value)),
    delete_session_meta: (sessionID) => safeAsync("delete_session_meta", undefined, () => deleteSessionMeta(sessionID)),
    session_meta: (sessionID) => safeAsync("session_meta", undefined, () => sessionMeta(sessionID)),
    session_metas: (value) => safeAsync("session_metas", new Map(), () => sessionMetas(value)),
    list_session_metas: (value) => safeAsync("list_session_metas", [], () => listSessionMetas(value)),
    list_session_navigation_metas: (value) =>
      safeAsync("list_session_navigation_metas", [], () => listSessionNavigationMetas(value)),
    tagged_session_metas: (tags, value) => safeAsync("tagged_session_metas", [], () => taggedSessionMetas(tags, value)),
    source_channel_session_counts_by_week: (value) => safeAsync("source_channel_session_counts_by_week", [], () => sourceChannelSessionCountsByWeek(value)),
    claim_channel_delivery: (value) => safeAsync("claim_channel_delivery", { ok: false, reason: "stale_delivery", message: "Channel delivery log unavailable" }, () => claimChannelDelivery(value)),
    remember_channel_delivery_session: (value) => safeAsync("remember_channel_delivery_session", undefined, () => rememberChannelDeliverySession(value)),
    release_channel_delivery: (value) => safeAsync("release_channel_delivery", undefined, () => releaseChannelDelivery(value)),
    count_channel_deliveries_by_user_day: (value) => safeAsync("count_channel_deliveries_by_user_day", 0, () => countChannelDeliveriesByUserDay(value)),
    record_channel_run_audit: (value) => safeAsync("record_channel_run_audit", undefined, () => recordChannelRunAudit(value)),
    channel_run_audit: (value) => safeAsync("channel_run_audit", undefined, () => channelRunAudit(value)),
    channel_run_audits: (value) => safeAsync("channel_run_audits", [], () => channelRunAudits(value)),
    persist_message_event: (sessionID, event) => {
      safeSync("persist_message_event", undefined, () => persistMessageEvent(sessionID, event))
    },
    read_session_messages: (sessionID) => safeSync("read_session_messages", [], () => readSessionMessages(sessionID)),
    read_session_max_event_ordinal: (sessionID) => safeSync("read_session_max_event_ordinal", 0, () => readSessionMaxEventOrdinal(sessionID)),
    subscribe_message_replay: (bus) => safeSync("subscribe_message_replay", () => {}, () => subscribeMessageReplay(bus)),
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
