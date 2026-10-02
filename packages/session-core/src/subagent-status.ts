import { isTerminalSubagentStatus, type SubagentObservation } from "@claxedo/agent-runtime-contract"

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
  if (currentTerminal && !incomingTerminal) return startsNewRun
  return !currentTerminal && incomingTerminal || incoming.revision > current.status_revision
}

/** `freshKeys` are the correlation keys this observation added to its subagent. */
export function observationStartsNewRun(observation: SubagentObservation, freshKeys: readonly string[]): boolean {
  if (!observation.toolCallId || !observation.status || isTerminalSubagentStatus(observation.status)) return false
  return freshKeys.includes(`tool:${observation.harnessExecutionId ?? ""}:${observation.toolCallId}`)
}
