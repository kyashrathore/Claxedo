import { backgroundWorkActive, NO_BACKGROUND_WORK, parseBackgroundWork, parseAgentTurnOutcome, sameBackgroundWork, type BackgroundWork, type AgentTurnOutcome, type SessionAttentionFacts } from "@claxedo/agent-runtime-contract"
import { asRecord, asString } from "@claxedo/helpers/guards"
import type { SqliteDatabase } from "../sqlite/database"
import { SESSION_OUTCOME_ELIGIBILITY_SQL, SESSION_OUTCOME_JOURNAL_SQL, sessionAttentionBoundary } from "./attention-journal"

type JournalFact = { seq: number; type: string; created_at: number; payload_json: string }
type Projection = {
  generation: number
  through: number
  activity: { seq: number; created_at: number }
  work?: BackgroundWork
  terminal?: JournalFact
  lastTurn?: AgentTurnOutcome
}
const projections = new WeakMap<SqliteDatabase, Map<string, Projection>>()
const CACHE_LIMIT = 512

export const SESSION_ATTENTION_TERMINAL_QUERY = `
  SELECT seq, type, created_at, payload_json FROM runtime_journal
  WHERE session_id = ? AND seq >= ? AND seq <= ?
    AND ${SESSION_OUTCOME_JOURNAL_SQL} AND ${SESSION_OUTCOME_ELIGIBILITY_SQL}
  ORDER BY seq DESC LIMIT 1
`

function projectAttention(db: SqliteDatabase, sessionId: string, boundary: NonNullable<ReturnType<typeof sessionAttentionBoundary>>): Projection {
  const cache = projections.get(db) ?? new Map<string, Projection>()
  projections.set(db, cache)
  const previous = cache.get(sessionId)
  const state: Projection = previous?.generation === boundary.generation && previous.through <= boundary.through
    ? { ...previous }
    : { generation: boundary.generation, through: boundary.generation - 1,
      activity: { seq: boundary.generation, created_at: boundary.createdAt } }
  if (state.through < boundary.through) {
    const records = db.prepare<JournalFact>(`
      SELECT seq, type, created_at, payload_json FROM runtime_journal
      WHERE session_id = ? AND seq > ? AND seq <= ? AND (
        (kind = 'control' AND type IN ('turn.start', 'turn.finish', 'session.interrupted', 'session.recovering', 'process.lost'))
        OR (kind = 'event' AND type IN ('message.completed', 'session.error', 'permission.asked', 'question.asked', 'session.background-work'))
      ) ORDER BY seq
    `).all(sessionId, state.through, boundary.through)
    for (const row of records) {
      let workChanged = false
      if (row.type === "session.background-work") {
        const work = parseBackgroundWork(asRecord(JSON.parse(row.payload_json))?.properties)
        if (!work) throw new Error("Invalid canonical background work")
        workChanged = !sameBackgroundWork(state.work ?? NO_BACKGROUND_WORK, work)
        state.work = work
      }
      if (['turn.start', 'turn.finish', 'session.interrupted', 'message.completed', 'session.error', 'permission.asked', 'question.asked'].includes(row.type)
        || workChanged) state.activity = row
    }
    if (!previous || previous.generation !== boundary.generation || previous.through > boundary.through || records.some((row) => row.type === 'turn.finish' || row.type === 'message.completed' || row.type === 'session.error')) {
      state.terminal = db.prepare<JournalFact>(SESSION_ATTENTION_TERMINAL_QUERY).get(sessionId, boundary.generation, boundary.through, boundary.generation) ?? undefined
      state.lastTurn = state.terminal ? outcomeOf(db, sessionId, boundary.generation, state.terminal) : undefined
    }
    state.through = boundary.through
  }
  cache.delete(sessionId)
  cache.set(sessionId, state)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return state
}

export function readSessionAttention(db: SqliteDatabase, sessionId: string, status?: string | null): { attention?: SessionAttentionFacts; lastTurn?: AgentTurnOutcome; backgroundWork?: BackgroundWork } {
  const boundary = sessionAttentionBoundary(db, sessionId)
  if (!boundary) { projections.get(db)?.delete(sessionId); return {} }
  const { activity, work, terminal, lastTurn } = projectAttention(db, sessionId, boundary)
  const pending = db.prepare<{ waiting: number }>(`
    SELECT EXISTS(SELECT 1 FROM pending_permission WHERE session_id = ? AND status = 'pending')
      OR EXISTS(SELECT 1 FROM pending_question WHERE session_id = ? AND status = 'pending') AS waiting
  `).get(sessionId, sessionId)
  const attention: SessionAttentionFacts = {
    sequence: boundary.through,
    generation: boundary.generation,
    activitySequence: activity.seq,
    activityAt: activity.created_at,
    working: status === 'busy' || status === 'retry' || status === 'recovering' || !!(work && backgroundWorkActive(work)),
    awaitingInput: pending?.waiting === 1,
    ...(lastTurn && terminal ? { outcome: { sequence: terminal.seq, status: lastTurn.status, completedAt: lastTurn.completedAt } } : {}),
  }
  return { attention, ...(lastTurn ? { lastTurn } : {}), ...(work ? { backgroundWork: work } : {}) }
}

function outcomeOf(db: SqliteDatabase, sessionId: string, generation: number, row: JournalFact): AgentTurnOutcome | undefined {
  if (row.type === "turn.finish") {
    const outcome = parseAgentTurnOutcome(asRecord(JSON.parse(row.payload_json))?.outcome)
    if (!outcome) throw new Error("Finished turn is missing its canonical outcome")
    return outcome
  }
  const properties = asRecord(JSON.parse(row.payload_json).properties)
  if (row.type === "message.completed") {
    const assistantMessageId = asString(properties?.messageID)
    if (!assistantMessageId) return undefined
    return { status: properties?.cancelled === true ? "cancelled" : "completed", assistantMessageId, completedAt: row.created_at }
  }
  const previous = db.prepare<{ assistant_message_id: string | null }>(`
    SELECT assistant_message_id FROM runtime_journal WHERE session_id = ?
      AND kind = 'control' AND type = 'turn.start' AND seq >= ? AND seq < ? ORDER BY seq DESC LIMIT 1
  `).get(sessionId, generation, row.seq)
  return {
    status: "failed",
    assistantMessageId: previous?.assistant_message_id ?? undefined,
    completedAt: row.created_at,
    error: asString(asRecord(asRecord(properties?.error)?.data)?.message) ?? "session error",
  }
}
