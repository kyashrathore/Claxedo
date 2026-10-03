import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RecordedSessionReader } from "@claxedo/server-core/platform/auth/session-reader-authority"
import { sessionReaderState, type SessionReaderWrite } from "@claxedo/server-core/session/reader"
import { requireHuman } from "./access-context"
import { maySql } from "./authorization"

type ReadableSession = { workspace_id: string; activity_at: number }

const SEEN_SQL = `
  insert into session_reads (user_id, session_id, seen_at) values (?, ?, ?)
  on conflict (user_id, session_id) do update set seen_at = max(coalesce(seen_at, 0), excluded.seen_at)
  returning seen_at, settled_at`

const SETTLED_SQL = `
  insert into session_reads (user_id, session_id, settled_at) values (?, ?, ?)
  on conflict (user_id, session_id) do update set settled_at = excluded.settled_at
  returning seen_at, settled_at`

/**
 * A settle records the session's own last activity, which the list compares
 * `settled_at` with, rather than this Worker's clock: the activity times come
 * from the runtime's clock, and a runtime clock ahead of the Worker's would
 * leave a just-settled session active.
 */
function upsertValue(write: SessionReaderWrite, session: ReadableSession): { sql: string; value: number | null } {
  if ("seenThrough" in write) return { sql: SEEN_SQL, value: write.seenThrough }
  return { sql: SETTLED_SQL, value: write.settled ? session.activity_at : null }
}

/** The caller's marks on a session it may read, after the write; nothing for a session it may not read. */
export async function recordD1SessionReader(
  database: D1Database,
  deploymentId: string,
  auth: SignedControlPlaneAuth,
  input: { sessionId: string; write: SessionReaderWrite },
): Promise<RecordedSessionReader | undefined> {
  const who = await requireHuman(database, deploymentId, auth)
  const reads = maySql(who, "read", { kind: "session", alias: "s" })
  const session = await database
    .prepare(`
      select s.workspace_id, max(coalesce(s.last_human_turn_at, 0), coalesce(s.last_turn_completed_at, 0)) as activity_at
      from sessions s
      where s.session_id = ? and s.deleted_at is null and ${reads.sql}
    `)
    .bind(input.sessionId, ...reads.bind)
    .first<ReadableSession>()
  if (!session) return undefined
  const { sql, value } = upsertValue(input.write, session)
  const row = await database.prepare(sql).bind(who.userId, input.sessionId, value).first<{ seen_at: number | null; settled_at: number | null }>()
  return { workspaceId: session.workspace_id, ...sessionReaderState(row?.seen_at ?? undefined, row?.settled_at ?? undefined) }
}
