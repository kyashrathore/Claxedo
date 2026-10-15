import type { D1Database } from "@cloudflare/workers-types"
import { interruptD1RuntimeSessions } from "../authority/adapters/d1/runtime-lost-sessions"
import { liveSyncRoomNameForPrincipal, nudgeLiveSyncRoom, type LiveSyncRoomNamespace } from "../platform/http/live-sync-publish"

/**
 * Ends the turns a lost runtime's sessions were running in the session
 * registry, and tells their readers in the workspace's org room, where the
 * runtime's own status notices go.
 */
export function d1RuntimeLost(input: { database: D1Database; room: LiveSyncRoomNamespace }) {
  return async (workspaceId: string, at: number) => {
    const notices = await interruptD1RuntimeSessions(input.database, workspaceId, at)
    const orgId = notices[0]?.orgId
    if (orgId) await nudgeLiveSyncRoom(input.room, liveSyncRoomNameForPrincipal({ orgId }), notices)
  }
}
