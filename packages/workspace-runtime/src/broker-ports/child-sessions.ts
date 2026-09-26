import { randomUUID } from "node:crypto"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { ChildSessionRef } from "@claxedo/harness/contract"
import type { RuntimeStore } from "../store"

type ChildRow = { assistant_message_id: string | null; created_at: number }

export function bindChildCorrelation(
  store: RuntimeStore, parentSessionId: string, correlationKey: string, childSessionId: string,
): void {
  const db = store.brokerDatabase()
  const child = db.prepare<{ subagent_key: string }>(`
    SELECT subagent_key FROM session_subagent
    WHERE parent_session_id = ? AND child_session_id = ?
  `).get(parentSessionId, childSessionId)
  if (!child) throw new Error(`Child ${childSessionId} was not admitted by ${parentSessionId}`)
  const key = `route:${correlationKey}`
  const existing = db.prepare<{ subagent_key: string }>(`
    SELECT subagent_key FROM session_subagent_correlation
    WHERE parent_session_id = ? AND correlation_key = ?
  `).get(parentSessionId, key)
  if (existing && existing.subagent_key !== child.subagent_key) throw new Error(`Child route ${correlationKey} is already bound`)
  db.prepare(`INSERT OR IGNORE INTO session_subagent_correlation
    (parent_session_id, correlation_key, subagent_key) VALUES (?, ?, ?)`)
    .run(parentSessionId, key, child.subagent_key)
}

export async function admitChildSession(
  store: RuntimeStore, parentSessionId: string, childSessionId: string,
  _observation: SubagentObservation,
): Promise<ChildSessionRef> {
  const db = store.brokerDatabase()
  const read = () => db.prepare<ChildRow>(`
    SELECT assistant_message_id, created_at FROM session_subagent
    WHERE parent_session_id = ? AND child_session_id = ?
  `).get(parentSessionId, childSessionId)
  const row = read()
  if (!row) throw new Error(`Child ${childSessionId} was not admitted by ${parentSessionId}`)
  if (!row.assistant_message_id) {
    db.prepare(`UPDATE session_subagent SET assistant_message_id = ?
      WHERE parent_session_id = ? AND child_session_id = ? AND assistant_message_id IS NULL`)
      .run(`msg_${randomUUID()}`, parentSessionId, childSessionId)
  }
  const committed = read()
  if (!committed?.assistant_message_id) throw new Error(`Child ${childSessionId} has no assistant message`)
  return { sessionId: childSessionId, assistantMessageId: committed.assistant_message_id, created: committed.created_at }
}
