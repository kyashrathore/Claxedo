import type { D1Database } from "@cloudflare/workers-types"

/** A session served by its own host keeps its transcript there, so its row is all the control plane holds of it. */
export async function deleteD1HostedSession(database: D1Database, input: { workspaceId: string; sessionId: string }, now: number): Promise<boolean> {
  const result = await database
    .prepare(`update sessions set deleted_at = ? where session_id = ? and workspace_id = ? and session_host_root = session_id and deleted_at is null`)
    .bind(now, input.sessionId, input.workspaceId)
    .run()
  return result.meta.changes > 0
}
