import type { RunID, WorkGraphContext, WorkItemID } from "../contracts"
import type { RunRuntimePort, ExecutionResult } from "../ports"

export type RunResultStore = Pick<RunRuntimePort, "recordResult">

/** Runtime termination records progress; explicit evidence evaluation completes work later. */
export async function recordSemanticRunResult(
  context: WorkGraphContext,
  ids: Readonly<{ runId: RunID; workItemId: WorkItemID; leaseEpoch: number }>,
  result: ExecutionResult,
  store: RunResultStore,
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
