import type { AgentMessage, AgentTurnOutcome } from "@claxedo/agent-runtime-contract"

export type TurnEvidenceDatabase = {
  prepare<Row>(sql: string): { get(...params: unknown[]): Row | null | undefined }
}

type TurnRowsDatabase = {
  prepare<Row>(sql: string): { get(...params: unknown[]): Row | null | undefined; all(...params: unknown[]): Row[] }
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

const MESSAGE_COMPLETED_SQL = `
  SELECT 1 AS found FROM runtime_journal
  WHERE session_id = ? AND kind = 'event' AND type = 'message.completed'
    AND json_extract(payload_json, '$.properties.messageID') = ?
  LIMIT 1
`

const JOURNALED_TURN_SQL = `
  SELECT turn_id FROM runtime_journal
  WHERE session_id = ? AND seq <= ? AND kind = 'control' AND type = 'turn.start'
  ORDER BY seq DESC LIMIT 1
`

const TURN_PROMPTS_SQL = `
  SELECT id, ord FROM message WHERE session_id = ? AND turn_id = ? AND role = 'user' ORDER BY ord ASC
`

const TURN_REPLY_SQL = `
  SELECT id, info_json FROM message WHERE session_id = ? AND turn_id = ? AND role = 'assistant' ORDER BY ord DESC LIMIT 1
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
  const started = readTurnId(db, sessionId, turnId)
  if (!started) return { started: false, finished: false }
  const finish = db.prepare<{ payload_json: string }>(TURN_FINISH_SQL).get(sessionId, started)
  if (!finish) return { started: true, finished: false }
  const payload: { outcome: AgentTurnOutcome } = JSON.parse(finish.payload_json)
  return { started: true, finished: true, outcome: payload.outcome }
}

/**
 * The turn a journal row at `seq` falls in: the newest turn started at or
 * before it, named by the assistant message id that start opened. Every prompt
 * steered into a turn and every reply it opened is journaled after its start
 * and before the next one, so this is the one rule for which turn a message
 * belongs to.
 */
export function readTurnFinished(db: TurnEvidenceDatabase, sessionId: string, assistantMessageId: string): boolean {
  return !!db.prepare<{ payload_json: string }>(TURN_FINISH_SQL).get(sessionId, assistantMessageId)
}

export function readMessageCompleted(db: TurnEvidenceDatabase, sessionId: string, messageId: string): boolean {
  return !!db.prepare<{ found: number }>(MESSAGE_COMPLETED_SQL).get(sessionId, messageId)
}

export function readJournaledTurn(db: TurnEvidenceDatabase, sessionId: string, seq: number): string | null {
  return db.prepare<{ turn_id: string }>(JOURNALED_TURN_SQL).get(sessionId, seq)?.turn_id ?? null
}

/** The id of the turn either of its message ids names. */
export function readTurnId(db: TurnEvidenceDatabase, sessionId: string, messageId: string): string | undefined {
  return db.prepare<{ assistant_message_id: string }>(TURN_START_SQL).get(sessionId, messageId, messageId)?.assistant_message_id
}

/** The turn's own prompt and every prompt steered into it, in projection order. */
export function readTurnPrompts(db: TurnRowsDatabase, sessionId: string, turnId: string): Array<{ id: string; ord: number }> {
  return db.prepare<{ id: string; ord: number }>(TURN_PROMPTS_SQL).all(sessionId, turnId)
}

/**
 * The latest turn whose prompts were projected before `endOrd`, as its first
 * prompt and all of its prompts: the turn of the latest prompt, whether that
 * prompt was its own or steered in. A prompt no turn holds stands as a turn
 * of its own.
 */
export function readLatestTurn(db: TurnRowsDatabase, sessionId: string, endOrd: number | undefined) {
  const prompt = db.prepare<{ id: string; ord: number; turn_id: string | null }>(
    `SELECT id, ord, turn_id FROM message WHERE session_id = ? AND role = 'user'${endOrd === undefined ? "" : " AND ord < ?"} ORDER BY ord DESC LIMIT 1`,
  ).get(...(endOrd === undefined ? [sessionId] : [sessionId, endOrd]))
  if (!prompt) return undefined
  const prompts = prompt.turn_id === null ? [prompt] : readTurnPrompts(db, sessionId, prompt.turn_id)
  const first = prompts[0] ?? prompt
  return { boundary: { id: first.id, ord: first.ord }, prompts: new Set(prompts.map((row) => row.id)) }
}

/** Where the projected messages of the turn whose prompt sits at `boundaryOrd` end: at the first prompt it did not take in. */
export function readTurnEndOrd(db: TurnEvidenceDatabase, sessionId: string, boundaryOrd: number, prompts: ReadonlySet<string>): number | null {
  const owned = [...prompts]
  return db.prepare<{ ord: number | null }>(
    `SELECT MIN(ord) AS ord FROM message WHERE session_id = ? AND role = 'user' AND ord > ? AND id NOT IN (${owned.map(() => "?").join(", ")})`,
  ).get(sessionId, boundaryOrd, ...owned)?.ord ?? null
}

/** One whole turn: its user message, then only the `prompts` taken into it and assistants that answer one of them. */
export function isContiguousTurn(rows: ReadonlyArray<{ id: string; info_json: string }>, prompts: ReadonlySet<string>) {
  const first = rows[0]
  if (!first) return false
  const user: AgentMessage["info"] = JSON.parse(first.info_json)
  if (user.role !== "user" || user.id !== first.id) return false
  return rows.slice(1).every((row) => {
    const message: AgentMessage["info"] = JSON.parse(row.info_json)
    if (message.role === "user") return prompts.has(message.id)
    return message.role === "assistant" && message.parentID !== undefined && prompts.has(message.parentID)
  })
}

/**
 * The reply a turn is writing, or ended in, with its message info JSON. A
 * harness step or a steered prompt continues a turn in a new reply, so this is
 * the turn's newest reply, not the one its own prompt opened.
 */
export function readTurnReply(db: TurnEvidenceDatabase, sessionId: string, turnId: string) {
  return db.prepare<{ id: string; info_json: string }>(TURN_REPLY_SQL).get(sessionId, turnId) ?? undefined
}

/**
 * The id of the reply the turn either of its message ids names ended in: its
 * newest reply, or the reply its start opened when no message was projected
 * into it.
 */
export function readTurnReplyId(db: TurnEvidenceDatabase, sessionId: string, messageId: string): string | undefined {
  const turnId = readTurnId(db, sessionId, messageId)
  if (!turnId) return undefined
  return readTurnReply(db, sessionId, turnId)?.id ?? turnId
}

/**
 * Whether a turn ever started on one harness session. A turn's start row
 * carries the upstream id the session was bound to when it was admitted, so a
 * harness switch leaves the earlier upstream's turns out of the answer.
 */
export function readUpstreamHasTurns(db: TurnEvidenceDatabase, sessionId: string, upstreamSessionId: string): boolean {
  return !!db.prepare<{ found: number }>(UPSTREAM_TURN_SQL).get(sessionId, upstreamSessionId)
}
