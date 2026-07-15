import type { AttemptID, WorkGraphContext, WorkItemID } from "../contracts"
import type { AttemptRuntimePort, ExecutionResult } from "../ports"

export type AttemptResultStore = Pick<AttemptRuntimePort, "recordResult">

/** Runtime termination records progress; explicit evidence evaluation completes work later. */
export async function recordSemanticAttemptResult(
  context: WorkGraphContext,
  ids: Readonly<{ attemptId: AttemptID; workItemId: WorkItemID; leaseEpoch: number }>,
  result: ExecutionResult,
  store: AttemptResultStore,
) {
  if (result.state === "pending" || result.state === "running") return { settled: false as const }
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
