import type { RunID, WorkGraphContext, WorkItemID } from "../contracts"
import type { ExecutionSessionID, RunRuntimePort, ExecutionResult } from "../ports"

export type RunResultStore =
  & Pick<RunRuntimePort, "recordResult">
  & Partial<Pick<RunRuntimePort, "park">>

/** Runtime termination records progress; explicit evidence evaluation completes work later. */
export async function recordSemanticRunResult(
  context: WorkGraphContext,
  ids: Readonly<{
    runId: RunID
    workItemId: WorkItemID
    sessionId?: ExecutionSessionID
    leaseEpoch: number
  }>,
  result: ExecutionResult,
  store: RunResultStore,
) {
  if (result.state === "pending" || result.state === "running") return { settled: false as const }
  if (result.state === "parked") {
    if (!ids.sessionId || !store.park) return { settled: false as const }
    const parked = await store.park(context, {
      runId: ids.runId,
      workItemId: ids.workItemId,
      sessionId: ids.sessionId,
      leaseEpoch: ids.leaseEpoch,
      reason: result.message,
    })
    if (!parked || parked.state === "parked") {
      return {
        settled: false as const,
        ...(parked ? { parked: true as const, retryAfterMs: parked.retryAfterMs } : {}),
      }
    }
    return { settled: true as const, workItemState: "failed" as const }
  }
  if (result.state === "succeeded") {
    return { settled: false as const, awaitingExplicitCompletion: true as const }
  }
  if (result.state === "failed") {
    if (!(await store.recordResult(context, { ...ids, state: "failed", reason: result.message }))) {
      return { settled: false as const }
    }
    return { settled: true as const, workItemState: "failed" as const }
  }
  if (!(await store.recordResult(context, { ...ids, state: "cancelled" }))) return { settled: false as const }
  return { settled: true as const, workItemState: "failed" as const }
}
