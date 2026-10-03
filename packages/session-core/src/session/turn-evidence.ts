import type { AgentTurnOutcome } from "@claxedo/agent-runtime-contract"

export type TurnEvidenceDatabase = {
  prepare<Row>(sql: string): { get(...params: unknown[]): Row | null | undefined }
}

export type TurnEvidence = { started: boolean; finished: boolean; outcome?: AgentTurnOutcome }

const TURN_START_SQL = `
  SELECT seq, assistant_message_id FROM runtime_journal
  WHERE session_id = ? AND kind = 'control' AND type = 'turn.start'
    AND (assistant_message_id = ? OR user_message_id = ?)
  ORDER BY seq DESC LIMIT 1
`

const TURN_FINISH_SQL = `
  SELECT payload_json FROM runtime_journal
  WHERE session_id = ? AND kind = 'control' AND type = 'turn.finish' AND assistant_message_id = ?
  ORDER BY seq DESC LIMIT 1
`

const NEXT_TURN_START_SQL = `
  SELECT MIN(seq) AS seq FROM runtime_journal
  WHERE session_id = ? AND seq > ? AND kind = 'control' AND type = 'turn.start'
`

const TURN_REPLY_SQL = `
  SELECT json_extract(payload_json, '$.properties.info.id') AS id, json_extract(payload_json, '$.properties.info') AS info_json
  FROM runtime_journal
  WHERE session_id = ? AND seq > ? AND seq < ? AND kind = 'event' AND type = 'message.updated'
    AND json_extract(payload_json, '$.properties.info.role') = 'assistant'
  ORDER BY seq DESC LIMIT 1
`

const UPSTREAM_TURN_SQL = `
  SELECT 1 AS found FROM runtime_journal
  WHERE session_id = ? AND kind = 'control' AND type = 'turn.start' AND provider_session_id = ?
  LIMIT 1
`

/**
 * What the journal records about one turn, for a caller deciding whether a
 * cancellation still has anything to cancel.
 *
 * Either of the turn's two message ids identifies it. The journal keys turn
 * rows on the assistant message id, while a recovery target carries the user
 * message id the caller was given at admission, and neither side can derive
 * the other without this lookup.
 */
export function readTurnEvidence(db: TurnEvidenceDatabase, sessionId: string, turnId: string): TurnEvidence {
  const start = db.prepare<{ assistant_message_id: string }>(TURN_START_SQL).get(sessionId, turnId, turnId)
  if (!start) return { started: false, finished: false }
  const finish = db.prepare<{ payload_json: string }>(TURN_FINISH_SQL).get(sessionId, start.assistant_message_id)
  if (!finish) return { started: true, finished: false }
  const payload: { outcome: AgentTurnOutcome } = JSON.parse(finish.payload_json)
  return { started: true, finished: true, outcome: payload.outcome }
}

/**
 * The reply a turn is writing, or ended in, with its message info JSON. A
 * harness step or a steered prompt continues a turn in a new reply, so this is
 * the newest assistant message journaled between the turn's start and the
 * next turn's, not the one its own prompt opened.
 */
export function readTurnReply(db: TurnEvidenceDatabase, sessionId: string, turnStartSeq: number) {
  const next = db.prepare<{ seq: number | null }>(NEXT_TURN_START_SQL).get(sessionId, turnStartSeq)?.seq ?? Number.MAX_SAFE_INTEGER
  return db.prepare<{ id: string; info_json: string }>(TURN_REPLY_SQL).get(sessionId, turnStartSeq, next) ?? undefined
}

/**
 * The id of the reply the turn either of its message ids names ended in: its
 * newest reply segment, or the reply its start opened when it never began
 * another.
 */
export function readTurnReplyId(db: TurnEvidenceDatabase, sessionId: string, turnId: string): string | undefined {
  const start = db.prepare<{ seq: number; assistant_message_id: string }>(TURN_START_SQL).get(sessionId, turnId, turnId)
  if (!start) return undefined
  return readTurnReply(db, sessionId, start.seq)?.id ?? start.assistant_message_id
}

/**
 * Whether a turn ever started on one harness session. A turn's start row
 * carries the upstream id the session was bound to when it was admitted, so a
 * harness switch leaves the earlier upstream's turns out of the answer.
 */
export function readUpstreamHasTurns(db: TurnEvidenceDatabase, sessionId: string, upstreamSessionId: string): boolean {
  return !!db.prepare<{ found: number }>(UPSTREAM_TURN_SQL).get(sessionId, upstreamSessionId)
}
