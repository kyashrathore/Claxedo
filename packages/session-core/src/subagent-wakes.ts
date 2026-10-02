import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { SqliteDatabase } from "./sqlite/database"

export function subagentWakeAfterReceipt(db: SqliteDatabase, parentSessionId: string, subagentKey: string, receipt: string) {
  return pendingSubagentWakes(db).some((wake) => wake.parentSessionId === parentSessionId && wake.subagentKey === subagentKey && wake.result?.observationId !== receipt)
    ? "pending" as const : "delivered" as const
}

type WakeRow = { parent_session_id: string; subagent_key: string; child_session_id: string; directory: string; observation_id?: string; observation_json?: string }

export function pendingSubagentWakes(db: SqliteDatabase) {
  const rows = db.prepare<WakeRow>(`
    SELECT subagent.parent_session_id, subagent.subagent_key, subagent.child_session_id, parent.directory,
      result.observation_id, result.observation_json, result.created_at AS queued_at, result.revision AS revision
    FROM session_subagent subagent
    JOIN session parent ON parent.id = subagent.parent_session_id
    JOIN session_subagent_observation result ON result.parent_session_id = subagent.parent_session_id
      AND result.subagent_key = subagent.subagent_key
    WHERE subagent.child_session_id IS NOT NULL
      AND json_type(result.observation_json, '$.wakeResult') = 'object'
      AND NOT EXISTS (
        SELECT 1 FROM session_subagent_observation receipt
        WHERE receipt.parent_session_id = result.parent_session_id AND receipt.subagent_key = result.subagent_key
          AND json_extract(receipt.observation_json, '$.wakeReceipt') = result.observation_id
      )
    UNION ALL
    SELECT subagent.parent_session_id, subagent.subagent_key, subagent.child_session_id, parent.directory, NULL, NULL,
      subagent.updated_at AS queued_at, subagent.revision AS revision
    FROM session_subagent subagent
    JOIN session parent ON parent.id = subagent.parent_session_id
    WHERE subagent.wake = 'pending' AND subagent.child_session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM session_subagent_observation result
        WHERE result.parent_session_id = subagent.parent_session_id AND result.subagent_key = subagent.subagent_key
          AND json_type(result.observation_json, '$.wakeResult') = 'object'
      )
    ORDER BY queued_at, parent_session_id, revision, subagent_key
  `).all()
  return rows.map((row) => ({
    parentSessionId: row.parent_session_id,
    subagentKey: row.subagent_key,
    childSessionId: row.child_session_id,
    directory: row.directory,
    ...(row.observation_id && row.observation_json ? {
      result: { observationId: row.observation_id, summary: (JSON.parse(row.observation_json) as SubagentObservation).wakeResult! },
    } : {}),
  }))
}
