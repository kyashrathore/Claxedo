import type { D1Database } from "@cloudflare/workers-types"
import type { SessionStatusChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { SESSION_STATUS_COLUMNS, sessionStatusNotices, type SessionStatusColumns } from "./session-status-notices"

const RUNNING_ON_RUNTIME = `workspace_id = ? and deleted_at is null and session_host_root is null and status in ('busy', 'retry')`

/**
 * Ends what the sessions of a workspace's runtime were running when that
 * runtime was found gone at `at`: each busy or retrying row reads
 * interrupted, as the runtime itself writes it when it starts again. A
 * session served by its own host runs without the runtime and is left, as is
 * a status the runtime reported after `at`. Answers the status notices owed
 * to each reader of a session it changed.
 */
export async function interruptD1RuntimeSessions(database: D1Database, workspaceId: string, at: number): Promise<SessionStatusChangedEvent[]> {
  const [before, written] = await database.batch<SessionStatusColumns>([
    database.prepare(`select ${SESSION_STATUS_COLUMNS} from sessions where ${RUNNING_ON_RUNTIME}`).bind(workspaceId),
    database
      .prepare(`
        update sessions set status = 'interrupted', awaiting_input = 0, status_at = ?
        where ${RUNNING_ON_RUNTIME} and (status_at is null or status_at <= ?)
        returning ${SESSION_STATUS_COLUMNS}
      `)
      .bind(at, workspaceId, at),
  ])
  if (!written?.results.length) return []
  return await sessionStatusNotices(database, new Map(before.results.map((row) => [row.session_id, row])), written.results)
}
