import { isTerminalSubagentStatus, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { SqliteDatabase } from "./sqlite/database"

export function subagentRunRevision(db: SqliteDatabase, parentSessionId: string, subagentKey: string, observation?: SubagentObservation): number | undefined {
  const scoped = observation?.providerKind === "claxedo" && observation.stableCorrelationId !== undefined
  return db.prepare<{ revision: number | null }>(`
    SELECT MAX(json_extract(event_json, '$.runRevision')) AS revision FROM session_subagent_observation
    WHERE parent_session_id = ? AND subagent_key = ?
      ${scoped ? "AND json_extract(observation_json, '$.stableCorrelationId') = ? AND json_extract(observation_json, '$.harnessExecutionId') = ?" : ""}
  `).get(parentSessionId, subagentKey, ...(scoped ? [observation.stableCorrelationId!, observation.harnessExecutionId!] : []))?.revision ?? undefined
}

/**
 * Whether an incoming status replaces the stored one. A terminal status wins
 * over a running one and then stays: a late or replayed running report leaves
 * a finished subagent finished. The one exception is a new run: a call the
 * subagent never ran under reporting it running, as Claude's SendMessage does
 * when it resumes a stopped agent.
 */
export function subagentStatusAdvances(
  current: { status: string; status_revision: number },
  incoming: { status: string; revision: number },
  startsNewRun: boolean,
): boolean {
  const currentTerminal = isTerminalSubagentStatus(current.status)
  const incomingTerminal = isTerminalSubagentStatus(incoming.status)
  if (currentTerminal && !incomingTerminal) return startsNewRun && incoming.revision > current.status_revision
  return !currentTerminal && incomingTerminal || incoming.revision > current.status_revision
}

/** `freshKeys` are the correlation keys this observation added to its subagent. */
export function observationStartsNewRun(observation: SubagentObservation, freshKeys: readonly string[]): boolean {
  if (!observation.status || isTerminalSubagentStatus(observation.status)) return false
  if (observation.providerKind === "claxedo" && observation.stableCorrelationId) {
    return freshKeys.includes(`stable:${observation.harnessExecutionId ?? ""}:${observation.stableCorrelationId}`)
  }
  return !!observation.toolCallId && freshKeys.includes(`tool:${observation.harnessExecutionId ?? ""}:${observation.toolCallId}`)
}
