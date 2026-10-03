import { isTerminalSubagentStatus, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { SqliteDatabase } from "./sqlite/database"

const stableRunKey = (observation: SubagentObservation) => `stable:${observation.harnessExecutionId ?? ""}:${observation.stableCorrelationId}`

/**
 * The revision that started a subagent's current run, or, for a host child's
 * observation naming its turn, the revision that started that turn's run.
 */
export function subagentRunRevision(db: SqliteDatabase, parentSessionId: string, subagentKey: string, observation?: SubagentObservation): number | undefined {
  if (observation?.providerKind === "claxedo" && observation.stableCorrelationId !== undefined) {
    return db.prepare<{ run_revision: number | null }>(`
      SELECT run_revision FROM session_subagent_correlation WHERE parent_session_id = ? AND correlation_key = ? AND subagent_key = ?
    `).get(parentSessionId, stableRunKey(observation), subagentKey)?.run_revision ?? undefined
  }
  return db.prepare<{ run_revision: number | null }>(`
    SELECT run_revision FROM session_subagent WHERE parent_session_id = ? AND subagent_key = ?
  `).get(parentSessionId, subagentKey)?.run_revision ?? undefined
}

/** `freshKeys` are the correlation keys the run's first observation added; each names this run from then on. */
export function recordSubagentRun(db: SqliteDatabase, parentSessionId: string, subagentKey: string, freshKeys: readonly string[], revision: number) {
  db.prepare("UPDATE session_subagent SET run_revision = ? WHERE parent_session_id = ? AND subagent_key = ?").run(revision, parentSessionId, subagentKey)
  for (const key of freshKeys) {
    db.prepare("UPDATE session_subagent_correlation SET run_revision = ? WHERE parent_session_id = ? AND correlation_key = ? AND subagent_key = ?")
      .run(revision, parentSessionId, key, subagentKey)
  }
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
  if (observation.providerKind === "claxedo" && observation.stableCorrelationId) return freshKeys.includes(stableRunKey(observation))
  return !!observation.toolCallId && freshKeys.includes(`tool:${observation.harnessExecutionId ?? ""}:${observation.toolCallId}`)
}
