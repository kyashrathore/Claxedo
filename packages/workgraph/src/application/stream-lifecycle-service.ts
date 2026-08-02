import type { StreamID, WorkGraphContext } from "../contracts"
import type { ChildIsolationID, StreamEnvelopeID, WorkspaceExecutionPort } from "../ports"

/** Cleanup is a required precondition for destructive deletion, not an after-hook. */
export async function cleanupStreamBeforeRemoval(
  context: WorkGraphContext,
  input: Readonly<{
    streamId: StreamID
    envelopeId: StreamEnvelopeID
    childIsolationIds?: readonly ChildIsolationID[]
    mode: "delete"
  }>,
  execution: WorkspaceExecutionPort,
  remove: () => Promise<void>,
) {
  await execution.cleanup(context, {
    streamId: input.streamId,
    envelopeId: input.envelopeId,
    childIsolationIds: input.childIsolationIds,
    reason: "delete",
  })
  await remove()
}
