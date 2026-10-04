import type { SubagentObservation, SubagentUpdatedEvent, SubagentWake } from "@claxedo/agent-runtime-contract"
import type { SqliteDatabase } from "./sqlite/database"

export type SubagentWakeResult = NonNullable<SubagentObservation["wakeResult"]>

export type PendingSubagentWake = {
  subagentKey: string
  childSessionId: string
  label?: string
  subagentType?: string
  /** The result's observation; the delivery names it as its `wakeReceipt`. */
  observationId: string
  result: SubagentWakeResult
}

/**
 * Applies an admitted observation's wake result or receipt, inside the
 * admission's transaction, and answers the subagent's wake state after it.
 */
export function recordSubagentWake(db: SqliteDatabase, parentSessionId: string, event: SubagentUpdatedEvent, observation: SubagentObservation): SubagentWake | undefined {
  const result = observation.wakeResult
  if (result) {
    db.prepare(`
      INSERT INTO session_subagent_wake (parent_session_id, observation_id, subagent_key, revision, status, text, assistant_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(parentSessionId, observation.observationId, event.subagentKey, event.revision, result.status, result.text, result.assistantMessageId ?? null, Date.now())
    return "pending"
  }
  if (!observation.wakeReceipt) return undefined
  db.prepare(`
    UPDATE session_subagent_wake SET delivered = 1, text = NULL
    WHERE parent_session_id = ? AND observation_id = ? AND subagent_key = ?
  `).run(parentSessionId, observation.wakeReceipt, event.subagentKey)
  const state = db.prepare<{ delivered: number }>(`
    SELECT MIN(delivered) AS delivered FROM session_subagent_wake WHERE parent_session_id = ? AND subagent_key = ?
  `).get(parentSessionId, event.subagentKey)
  return state?.delivered === 0 ? "pending" : "delivered"
}

/** Each subagent of one parent that was ever owed a wake, and whether one is still owed. */
export function subagentWakeStates(db: SqliteDatabase, parentSessionId: string): Map<string, SubagentWake> {
  const rows = db.prepare<{ subagent_key: string; delivered: number }>(`
    SELECT subagent_key, MIN(delivered) AS delivered FROM session_subagent_wake
    WHERE parent_session_id = ? GROUP BY subagent_key
  `).all(parentSessionId)
  return new Map(rows.map((row) => [row.subagent_key, row.delivered === 0 ? "pending" : "delivered"]))
}

type PendingRow = {
  observation_id: string
  subagent_key: string
  child_session_id: string
  label: string | null
  subagent_type: string | null
  status: SubagentWakeResult["status"]
  text: string
  assistant_message_id: string | null
}

/** One parent's undelivered results, oldest first. */
export function pendingSubagentWakes(db: SqliteDatabase, parentSessionId: string): PendingSubagentWake[] {
  return db.prepare<PendingRow>(`
    SELECT wake.observation_id, wake.subagent_key, subagent.child_session_id, subagent.label, subagent.subagent_type,
      wake.status, wake.text, wake.assistant_message_id
    FROM session_subagent_wake wake
    JOIN session_subagent subagent ON subagent.parent_session_id = wake.parent_session_id AND subagent.subagent_key = wake.subagent_key
    WHERE wake.parent_session_id = ? AND wake.delivered = 0 AND subagent.child_session_id IS NOT NULL
    ORDER BY wake.created_at, wake.revision, wake.subagent_key
  `).all(parentSessionId).map((row) => ({
    subagentKey: row.subagent_key,
    childSessionId: row.child_session_id,
    ...(row.label ? { label: row.label } : {}),
    ...(row.subagent_type ? { subagentType: row.subagent_type } : {}),
    observationId: row.observation_id,
    result: {
      status: row.status,
      text: row.text,
      ...(row.assistant_message_id ? { assistantMessageId: row.assistant_message_id } : {}),
    },
  }))
}

/** Every parent still owed a wake, with the directory its turns run in. */
export function subagentWakeParents(db: SqliteDatabase): Array<{ parentSessionId: string; directory: string }> {
  return db.prepare<{ parent_session_id: string; directory: string }>(`
    SELECT DISTINCT wake.parent_session_id, parent.directory
    FROM session_subagent_wake wake
    JOIN session parent ON parent.id = wake.parent_session_id
    WHERE wake.delivered = 0
  `).all().map((row) => ({ parentSessionId: row.parent_session_id, directory: row.directory }))
}

type RunningHostChild = { parent_session_id: string; subagent_key: string; revision: number; parent_archived: number; assistant_message_id: string | null }

/** Host children whose row says a run is in progress, each with the reply id the child's newest turn opened. */
export function runningHostChildren(db: SqliteDatabase) {
  return db.prepare<RunningHostChild>(`
    SELECT subagent.parent_session_id, subagent.subagent_key, subagent.revision,
      parent.archived_at IS NOT NULL AS parent_archived,
      (SELECT assistant_message_id FROM runtime_journal
        WHERE session_id = subagent.child_session_id AND kind = 'control' AND type = 'turn.start'
        ORDER BY seq DESC LIMIT 1) AS assistant_message_id
    FROM session_subagent subagent
    JOIN session parent ON parent.id = subagent.parent_session_id
    WHERE subagent.provider_kind = 'claxedo' AND subagent.status = 'running' AND subagent.child_session_id IS NOT NULL
  `).all().map((row) => ({
    parentSessionId: row.parent_session_id,
    subagentKey: row.subagent_key,
    revision: row.revision,
    parentArchived: !!row.parent_archived,
    ...(row.assistant_message_id ? { assistantMessageId: row.assistant_message_id } : {}),
  }))
}
