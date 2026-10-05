import type { D1Database } from "@cloudflare/workers-types"

/** A session served by its own host keeps its transcript there, so its row is all the control plane holds of it. */
export async function deleteD1HostedSession(database: D1Database, input: { workspaceId: string; sessionId: string }, now: number): Promise<boolean> {
  const result = await database
    .prepare(`update sessions set deleted_at = ? where session_id = ? and workspace_id = ? and session_host_root = session_id and deleted_at is null`)
    .bind(now, input.sessionId, input.workspaceId)
    .run()
  return result.meta.changes > 0
}

export async function listD1HostedSessions(database: D1Database, workspaceId: string): Promise<string[]> {
  const rows = await database
    .prepare(`select session_id from sessions where workspace_id = ? and session_host_root = session_id and deleted_at is null order by session_id`)
    .bind(workspaceId)
    .all<{ session_id: string }>()
  return rows.results.map((row) => row.session_id)
}
