import type { SqliteDatabase } from "../sqlite/database"

export const SESSION_OUTCOME_JOURNAL_SQL = `(
  (kind = 'control' AND type = 'turn.finish')
  OR (kind = 'event' AND type IN ('message.completed', 'session.error'))
)`

export const SESSION_OUTCOME_ELIGIBILITY_SQL = `(type = 'turn.finish' OR NOT EXISTS (
  SELECT 1 FROM runtime_journal started
  WHERE started.session_id = runtime_journal.session_id AND started.kind = 'control'
    AND started.type = 'turn.start' AND started.seq >= ?
    AND started.seq = (SELECT MAX(latest.seq) FROM runtime_journal latest
      WHERE latest.session_id = runtime_journal.session_id AND latest.kind = 'control'
        AND latest.type = 'turn.start' AND latest.seq < runtime_journal.seq)
    AND NOT EXISTS (SELECT 1 FROM runtime_journal finished
      WHERE finished.session_id = started.session_id AND finished.kind = 'control'
        AND finished.type = 'turn.finish' AND finished.assistant_message_id = started.assistant_message_id
        AND finished.seq > started.seq AND finished.seq < runtime_journal.seq)
))`

type Boundary = { generation: number; createdAt: number; through: number }
const boundaries = new WeakMap<SqliteDatabase, Map<string, Boundary>>()
const CACHE_LIMIT = 512

function retainBoundary(db: SqliteDatabase, sessionId: string, boundary: Boundary): Boundary {
  const cache = boundaries.get(db) ?? new Map<string, Boundary>()
  boundaries.set(db, cache)
  cache.delete(sessionId)
  cache.set(sessionId, boundary)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return boundary
}

export function sessionAttentionBoundary(db: SqliteDatabase, sessionId: string): { generation: number; createdAt: number; through: number } | undefined {
  const applied = db.prepare<{ last_seq: number }>("SELECT last_seq FROM journal_checkpoint WHERE session_id = ?").get(sessionId)
  if (!applied) { boundaries.get(db)?.delete(sessionId); return undefined }
  const cached = boundaries.get(db)?.get(sessionId)
  if (cached && applied.last_seq >= cached.through) {
    if (applied.last_seq === cached.through) return retainBoundary(db, sessionId, cached)
    const lifecycle = db.prepare<{ seq: number; type: string; created_at: number }>(`
      SELECT seq, type, created_at FROM runtime_journal WHERE session_id = ? AND seq > ? AND seq <= ?
        AND kind = 'control' AND type IN ('session.bind', 'session.delete') ORDER BY seq
    `).all(sessionId, cached.through, applied.last_seq)
    if (!lifecycle.some((row) => row.type === 'session.delete')) return retainBoundary(db, sessionId, { ...cached, through: applied.last_seq })
  }
  const generation = db.prepare<{ seq: number; created_at: number }>(`
    SELECT seq, created_at FROM runtime_journal
    WHERE session_id = ? AND seq <= ? AND kind = 'control' AND type = 'session.bind'
      AND seq > COALESCE((SELECT MAX(seq) FROM runtime_journal WHERE session_id = ? AND seq <= ? AND type = 'session.delete'), 0)
    ORDER BY seq ASC LIMIT 1
  `).get(sessionId, applied.last_seq, sessionId, applied.last_seq)
  if (!generation) throw new Error(`Session ${sessionId} has no journaled creation`)
  return retainBoundary(db, sessionId, { generation: generation.seq, createdAt: generation.created_at, through: applied.last_seq })
}
