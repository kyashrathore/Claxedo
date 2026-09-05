/**
 * The control-plane services a desktop-local server composes over.
 *
 * The hosted `createDefaultLocalControlPlaneServices` builds the same shape and
 * then some: a workspace authority, a relay, a sandbox manager, channel
 * delivery. This builds only what a machine with no account and no cloud can
 * actually use, which is why it is a separate function rather than a flag on
 * that one — the difference between the products should be visible as different
 * code, not as a boolean read at runtime.
 *
 * The projection store here is the SESSION half only. `claxedo-server`'s
 * SQLite central store implements the full `ProjectionStore`, channel delivery
 * included, and channels are a hosted capability; composing it here would pull
 * that surface into a build that cannot use it.
 */

import { createDurableSessionLog, type DurableSessionLog } from "@claxedo/server-core/platform/auth/durable-session-log"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { defaultControlPlaneCredentials } from "@claxedo/server-core/authority/default-credentials"
import type { SessionProjectionStore } from "@claxedo/server-core/authority/session-projection"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import { getSessionWriteMode } from "@claxedo/server-core/platform/runtime/profile"
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
} from "@claxedo/server-core/session/meta/index"
import {
  persistMessageEvent,
  readSessionMessages,
  readSessionMaxEventOrdinal,
} from "@claxedo/server-core/session/message-replay"
import { syncCloudMessages } from "@claxedo/server-core/session/sync"

/** The session-metadata projection, SQLite-backed, with no channel surface. */
export function localSessionProjectionStore(): SessionProjectionStore {
  return {
    sync_session_meta: syncSessionMeta,
    sync_session_metas: syncSessionMetas,
    sync_session_messages: syncCloudMessages,
    put_session_meta: putSessionMeta,
    delete_session_meta: deleteSessionMeta,
    session_meta: sessionMeta,
    session_metas: sessionMetas,
    list_session_metas: listSessionMetas,
    list_session_navigation_metas: listSessionNavigationMetas,
    tagged_session_metas: taggedSessionMetas,
    source_channel_session_counts_by_week: sourceChannelSessionCountsByWeek,
    read_session_messages: readSessionMessages,
    read_session_max_event_ordinal: readSessionMaxEventOrdinal,
  } as SessionProjectionStore
}

export function localDurableSessionLog(): DurableSessionLog {
  return createDurableSessionLog({
    persistMessageEvent,
    readSessionMessages,
    readSessionMaxEventOrdinal,
    mode: getSessionWriteMode,
  } as never)
}

export type LocalControlPlaneServicesOptions = {
  telemetry?: { capture: (distinctId: string, event: string, properties?: Record<string, unknown>) => void }
}

export function createLocalControlPlaneServices(
  options: LocalControlPlaneServicesOptions = {},
): ControlPlaneServicesContract {
  return {
    projectionStore: localSessionProjectionStore(),
    durableSessionLog: localDurableSessionLog(),
    sessionWriteMode: getSessionWriteMode,
    // Unsigned by construction. There is no account here and nothing to verify
    // a bearer against, so the loopback guard is the boundary.
    auth: localOnlyAuthAdapter(),
    credentials: defaultControlPlaneCredentials(),
    // No relay provider and no sandbox manager: this product provisions
    // nothing and reaches no Relay. Both are the empty shape rather than a
    // stub that pretends.
    relay: {},
    sandbox: {},
    telemetry: options.telemetry ?? { capture: () => {} },
    localExecution: { enabled: true },
  }
}
