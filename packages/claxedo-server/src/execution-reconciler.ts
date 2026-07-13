import type { AttemptID, WorkGraphContext, WorkItemID } from "@claxedo/workgraph/contracts"
import type { ExecutionSessionID, WorkspaceExecutionPort } from "@claxedo/workgraph"
import { recordSemanticAttemptResult, type AttemptResultStore } from "@claxedo/workgraph"

export async function reconcileWorkGraphAttempt(
  context: WorkGraphContext,
  input: Readonly<{ attemptId: AttemptID; workItemId: WorkItemID; sessionId: ExecutionSessionID; leaseEpoch: number }>,
  execution: WorkspaceExecutionPort,
  store: AttemptResultStore,
) {
  return recordSemanticAttemptResult(context, input, await execution.result(context, input), store)
}
