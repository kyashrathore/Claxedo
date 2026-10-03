import type { AgentMessage, AgentTurnOutcome } from "@claxedo/agent-runtime-contract"

export type TurnEvidenceDatabase = {
  prepare<Row>(sql: string): { get(...params: unknown[]): Row | null | undefined }
}

type TurnRowsDatabase = {
  prepare<Row>(sql: string): { get(...params: unknown[]): Row | null | undefined; all(...params: unknown[]): Row[] }
}

export type TurnEvidence = { started: boolean; finished: boolean; outcome?: AgentTurnOutcome }

const TURN_START_SQL = `
  SELECT seq, assistant_message_id, user_message_id FROM runtime_journal
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

const TURN_STEERED_PROMPTS_SQL = `
  SELECT json_extract(payload_json, '$.properties.info.id') AS id FROM runtime_journal
  WHERE session_id = ? AND seq > ? AND seq < ? AND kind = 'event' AND type = 'message.updated'
    AND json_extract(payload_json, '$.properties.info.role') = 'user'
`

const PROMPT_TURN_SQL = `
  SELECT start.seq, start.assistant_message_id, start.user_message_id, prompt.ord
  FROM runtime_journal start
  JOIN message prompt ON prompt.session_id = start.session_id AND prompt.id = start.user_message_id
  WHERE start.session_id = ? AND start.kind = 'control' AND start.type = 'turn.start' AND prompt.ord <= ?
  ORDER BY prompt.ord DESC LIMIT 1
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
 * A turn's span of its session's journal: from its start row up to the next
 * turn's. Every prompt steered into the turn and every reply it opened is
 * journaled inside it, so this is the one rule for which messages a turn holds.
 */
export type TurnExtent = { startSeq: number; endSeq: number; userMessageId?: string; assistantMessageId: string }

function turnEndSeq(db: TurnEvidenceDatabase, sessionId: string, startSeq: number) {
  return db.prepare<{ seq: number | null }>(NEXT_TURN_START_SQL).get(sessionId, startSeq)?.seq ?? Number.MAX_SAFE_INTEGER
}

type TurnStartRow = { seq: number; assistant_message_id: string; user_message_id: string | null }

/** The extent of the turn either of its message ids names. */
export function readTurnExtent(db: TurnEvidenceDatabase, sessionId: string, turnId: string): TurnExtent | undefined {
  const start = db.prepare<TurnStartRow>(TURN_START_SQL).get(sessionId, turnId, turnId)
  return start ? turnExtent(db, sessionId, start) : undefined
}

function turnExtent(db: TurnEvidenceDatabase, sessionId: string, start: TurnStartRow): TurnExtent {
  return {
    startSeq: start.seq,
    endSeq: turnEndSeq(db, sessionId, start.seq),
    ...(start.user_message_id ? { userMessageId: start.user_message_id } : {}),
    assistantMessageId: start.assistant_message_id,
  }
}

/** The turn's own prompt and every prompt steered into it. */
export function readTurnPromptIds(db: TurnRowsDatabase, sessionId: string, extent: TurnExtent): Set<string> {
  const steered = db.prepare<{ id: string }>(TURN_STEERED_PROMPTS_SQL).all(sessionId, extent.startSeq, extent.endSeq)
  return new Set([...(extent.userMessageId ? [extent.userMessageId] : []), ...steered.map((row) => row.id)])
}

/**
 * The latest turn whose prompts were projected before `endOrd`, as its first
 * message and its prompts: the turn whose extent journals the latest prompt,
 * whether as its own or steered in. A prompt no journaled turn holds stands as
 * a turn of its own.
 */
export function readLatestTurn(db: TurnRowsDatabase, sessionId: string, endOrd: number | undefined) {
  const prompt = db.prepare<{ id: string; ord: number }>(
    `SELECT id, ord FROM message WHERE session_id = ? AND role = 'user'${endOrd === undefined ? "" : " AND ord < ?"} ORDER BY ord DESC LIMIT 1`,
  ).get(...(endOrd === undefined ? [sessionId] : [sessionId, endOrd]))
  if (!prompt) return undefined
  const start = db.prepare<TurnStartRow & { ord: number }>(PROMPT_TURN_SQL).get(sessionId, prompt.ord)
  const prompts = start?.user_message_id ? readTurnPromptIds(db, sessionId, turnExtent(db, sessionId, start)) : undefined
  if (!start?.user_message_id || !prompts?.has(prompt.id)) return { boundary: prompt, prompts: new Set([prompt.id]) }
  return { boundary: { id: start.user_message_id, ord: start.ord }, prompts }
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
 * the newest assistant message journaled in the turn's extent, not the one its
 * own prompt opened.
 */
export function readTurnReply(db: TurnEvidenceDatabase, sessionId: string, turnStartSeq: number) {
  return db.prepare<{ id: string; info_json: string }>(TURN_REPLY_SQL).get(sessionId, turnStartSeq, turnEndSeq(db, sessionId, turnStartSeq)) ?? undefined
}

/**
 * The id of the reply the turn either of its message ids names ended in: its
 * newest reply segment, or the reply its start opened when it never began
 * another.
 */
export function readTurnReplyId(db: TurnEvidenceDatabase, sessionId: string, turnId: string): string | undefined {
  const extent = readTurnExtent(db, sessionId, turnId)
  if (!extent) return undefined
  return readTurnReply(db, sessionId, extent.startSeq)?.id ?? extent.assistantMessageId
}

/**
 * Whether a turn ever started on one harness session. A turn's start row
 * carries the upstream id the session was bound to when it was admitted, so a
 * harness switch leaves the earlier upstream's turns out of the answer.
 */
export function readUpstreamHasTurns(db: TurnEvidenceDatabase, sessionId: string, upstreamSessionId: string): boolean {
  return !!db.prepare<{ found: number }>(UPSTREAM_TURN_SQL).get(sessionId, upstreamSessionId)
}
