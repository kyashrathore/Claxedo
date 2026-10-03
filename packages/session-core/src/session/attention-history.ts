import type { SessionAttentionEvent, SessionAttentionPage } from "@claxedo/agent-runtime-contract"
import { asRecord, asString } from "@claxedo/helpers/guards"
import type { SqliteDatabase } from "../sqlite/database"
import { SESSION_OUTCOME_ELIGIBILITY_SQL, SESSION_OUTCOME_JOURNAL_SQL, sessionAttentionBoundary } from "./attention-journal"

type AttentionRecord = { seq: number; type: string; created_at: number; payload_json: string }

export function readSessionAttentionHistory(db: SqliteDatabase, sessionId: string, after: number, limit: number): SessionAttentionPage {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid session attention page")
  const facts = sessionAttentionBoundary(db, sessionId)
  if (!facts) throw new Error(`Session ${sessionId} has no applied journal`)
  if (after > facts.through) throw new Error("Attention cursor is ahead of the journal")
  const records = db.prepare<AttentionRecord>(`
    SELECT seq, type, created_at, payload_json FROM runtime_journal
    WHERE session_id = ? AND seq >= ? AND seq > ? AND seq <= ? AND (
      (kind = 'event' AND type IN ('permission.asked', 'question.asked'))
      OR (${SESSION_OUTCOME_JOURNAL_SQL} AND ${SESSION_OUTCOME_ELIGIBILITY_SQL})
    ) ORDER BY seq ASC LIMIT ?
  `).all(sessionId, facts.generation, after, facts.through, facts.generation, limit + 1)
  const shown = records.slice(0, limit)
  return {
    generation: facts.generation,
    through: facts.through,
    events: shown.map(attentionEvent),
    ...(records.length > limit ? { next: shown.at(-1)!.seq } : {}),
  }
}

function attentionEvent(row: AttentionRecord): SessionAttentionEvent {
  const payload = asRecord(JSON.parse(row.payload_json))
  const properties = asRecord(payload?.properties)
  const base = { sequence: row.seq, openedAt: row.created_at }
  if (row.type === "permission.asked" || row.type === "question.asked") {
    const requestId = asString(properties?.id)
    if (!requestId) throw new Error(`Journal attention ${row.seq} has no request identity`)
    return { ...base, kind: row.type === "permission.asked" ? "permission" : "question", requestId }
  }
  const outcome = row.type === "turn.finish" ? asRecord(payload?.outcome)?.status
    : row.type === "session.error" ? "failed" : properties?.cancelled === true ? "cancelled" : "completed"
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "cancelled") throw new Error(`Journal attention ${row.seq} has no outcome`)
  return { ...base, kind: "outcome", outcome }
}
