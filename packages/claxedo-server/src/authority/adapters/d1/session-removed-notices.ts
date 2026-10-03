import type { D1Database } from "@cloudflare/workers-types"
import type { SessionRef } from "@claxedo/agent-runtime-contract"
import type { SessionRemovedEvent } from "@claxedo/server-core/platform/runtime/lib/session-state-events"
import { sessionNoticeReadersSql } from "./session-notice-readers"

export async function readD1SessionRemovedNotices(database: D1Database, refs: readonly SessionRef[]): Promise<SessionRemovedEvent[]> {
  if (!refs.length) return []
  const result = await database.prepare(`SELECT s.session_id, s.workspace_id, s.org_id, s.project_id,
      s.deleted_at, recipient.user_id ${sessionNoticeReadersSql("read_removed")}
    ORDER BY s.session_id, recipient.user_id`).bind(JSON.stringify(refs))
    .all<{ session_id: string; workspace_id: string; org_id: string; project_id: string; deleted_at: number; user_id: string }>()
  return result.results.map((row) => ({
    type: "session.removed",
    ownerUserId: row.user_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    orgId: row.org_id,
    projectId: row.project_id,
    ts: row.deleted_at,
  }))
}
