import type { RunID, WorkGraphContext, WorkItemID } from "@claxedo/workgraph/contracts"
import type { ExecutionSessionID, WorkspaceExecutionPort } from "@claxedo/workgraph"
import { recordSemanticRunResult, type RunResultStore } from "@claxedo/workgraph"

export async function reconcileWorkGraphRun(
  context: WorkGraphContext,
  input: Readonly<{ runId: RunID; workItemId: WorkItemID; sessionId: ExecutionSessionID; leaseEpoch: number }>,
  execution: WorkspaceExecutionPort,
  store: RunResultStore,
) {
  return recordSemanticRunResult(context, input, await execution.result(context, input), store)
}
