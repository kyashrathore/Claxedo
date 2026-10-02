import type { AgentTurnOutcome } from "@claxedo/agent-runtime-contract"

export type TurnEvidenceDatabase = {
  prepare<Row>(sql: string): { get(...params: unknown[]): Row | null | undefined }
}

export type TurnEvidence = { started: boolean; finished: boolean; outcome?: AgentTurnOutcome }

const TURN_START_SQL = `
  SELECT assistant_message_id FROM runtime_journal
  WHERE session_id = ? AND kind = 'control' AND type = 'turn.start'
    AND (assistant_message_id = ? OR user_message_id = ?)
  ORDER BY seq DESC LIMIT 1
`

const TURN_FINISH_SQL = `
  SELECT payload_json FROM runtime_journal
  WHERE session_id = ? AND kind = 'control' AND type = 'turn.finish' AND assistant_message_id = ?
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
 * Whether a turn ever started on one harness session. A turn's start row
 * carries the upstream id the session was bound to when it was admitted, so a
 * harness switch leaves the earlier upstream's turns out of the answer.
 */
export function readUpstreamHasTurns(db: TurnEvidenceDatabase, sessionId: string, upstreamSessionId: string): boolean {
  return !!db.prepare<{ found: number }>(UPSTREAM_TURN_SQL).get(sessionId, upstreamSessionId)
}
