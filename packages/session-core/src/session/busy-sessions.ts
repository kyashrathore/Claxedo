import type { SqliteDatabase } from "../sqlite/database"

export function busySessions(db: SqliteDatabase) {
  return db.prepare<{ id: string; agent_session_id: string | null }>("SELECT id, agent_session_id FROM session WHERE status IN ('busy', 'retry')").all()
}
