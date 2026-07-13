import type { StreamID, WorkGraphContext } from "@claxedo/workgraph/contracts"
import {
  WorkGraphOwnerDeletionError,
  type ChildIsolationID,
  type StreamEnvelopeID,
  type WorkGraphOwnerDeletionPort,
  type WorkGraphOwnerDeletionResult,
  type WorkspaceExecutionPort,
} from "@claxedo/workgraph/ports"
import { workGraphConvexApi } from "./convex-api"
import {
  createWorkGraphConvexExecutor,
  type WorkGraphConvexExecutor,
} from "./convex-store"

type CleanupTarget = Readonly<{
  streamId: StreamID
  envelopeId: StreamEnvelopeID
  childIsolationIds: readonly ChildIsolationID[]
}>

type Input = Readonly<{
  url?: string
  serviceToken: string
  executor?: WorkGraphConvexExecutor
  execution: Pick<WorkspaceExecutionPort, "cleanup">
  clock?: Readonly<{ now: () => number }>
}>

export function createConvexWorkGraphOwnerDeletionPort(input: Input): WorkGraphOwnerDeletionPort {
  if (!input.executor && !input.url) throw new Error("Convex WorkGraph URL is required")
  if (!input.serviceToken.trim()) throw new Error("Convex WorkGraph service token is required for owner deletion")
  const executor = input.executor ?? createWorkGraphConvexExecutor(input.url!)
  const clock = input.clock ?? { now: Date.now }

  return {
    deleteOwner: async (context, request) => {
      requireOwner(context)
      const prepared = await mutate(executor, workGraphConvexApi.workgraphOwnerDeletion.prepareForService, {
        service_token: input.serviceToken,
        owner_subject: context.ownerUserId,
        operation_id: request.operationId,
        now: clock.now(),
      })
      if (!prepared || typeof prepared !== "object" || !("ok" in prepared)) throw storageFailed()
      if (!prepared.ok) throw deletionFailure(prepared)
      if (!("state" in prepared) || typeof prepared.state !== "string") throw storageFailed()
      if (prepared.state === "completed") return deletionResult("result" in prepared ? prepared.result : undefined)
      if (prepared.state === "in_progress") throw new WorkGraphOwnerDeletionError("in_progress")
      if (!["acquired", "deleting"].includes(prepared.state) || !("targetSnapshotHash" in prepared) ||
        typeof prepared.targetSnapshotHash !== "string") throw storageFailed()
      if (prepared.state === "acquired") {
        if (!("targets" in prepared)) throw storageFailed()
        const targets = cleanupTargets(prepared.targets)
        try {
          await targets.reduce(
            (previous, target) => previous.then(() => input.execution.cleanup(context, {
              streamId: target.streamId,
              envelopeId: target.envelopeId,
              childIsolationIds: target.childIsolationIds,
              reason: "delete",
            })),
            Promise.resolve(),
          )
        } catch {
          await release(executor, input.serviceToken, context, request.operationId)
          throw new WorkGraphOwnerDeletionError("cleanup_failed")
        }
      }

      for (;;) {
        const finalized = await mutate(executor, workGraphConvexApi.workgraphOwnerDeletion.finalizeForService, {
          service_token: input.serviceToken,
          owner_subject: context.ownerUserId,
          operation_id: request.operationId,
          target_snapshot_hash: prepared.targetSnapshotHash,
          now: clock.now(),
        })
        if (!finalized || typeof finalized !== "object" || !("ok" in finalized)) throw storageFailed()
        if (!finalized.ok) throw deletionFailure(finalized)
        if ("state" in finalized && finalized.state === "deleting") continue
        return deletionResult("result" in finalized ? finalized.result : undefined)
      }
    },
  }
}

async function release(
  executor: WorkGraphConvexExecutor,
  serviceToken: string,
  context: WorkGraphContext,
  operationId: string,
) {
  const result = await mutate(executor, workGraphConvexApi.workgraphOwnerDeletion.releaseForService, {
    service_token: serviceToken,
    owner_subject: context.ownerUserId,
    operation_id: operationId,
  }).catch(() => undefined)
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw storageFailed()
}

function mutate(executor: WorkGraphConvexExecutor, fn: unknown, args: Record<string, unknown>) {
  return executor.mutation(fn, args).catch(() => {
    throw storageFailed()
  })
}

function cleanupTargets(value: unknown): readonly CleanupTarget[] {
  if (!Array.isArray(value)) throw storageFailed()
  return value.map((target) => {
    if (!target || typeof target !== "object" ||
      !("streamId" in target) || typeof target.streamId !== "string" || !target.streamId ||
      !("envelopeId" in target) || typeof target.envelopeId !== "string" || !target.envelopeId ||
      !("childIsolationIds" in target) || !Array.isArray(target.childIsolationIds) ||
      !target.childIsolationIds.every((id: unknown) => typeof id === "string" && id.length > 0)) throw storageFailed()
    return {
      streamId: target.streamId as StreamID,
      envelopeId: target.envelopeId as StreamEnvelopeID,
      childIsolationIds: target.childIsolationIds as ChildIsolationID[],
    }
  })
}

function deletionResult(value: unknown): WorkGraphOwnerDeletionResult {
  if (!value || typeof value !== "object" ||
    !("deleted" in value) || value.deleted !== true ||
    !("recordCount" in value) || !nonnegativeInteger(value.recordCount) ||
    !("workspaceCount" in value) || !nonnegativeInteger(value.workspaceCount) ||
    !("completedAt" in value) || !nonnegativeInteger(value.completedAt)) throw storageFailed()
  return value as WorkGraphOwnerDeletionResult
}

function deletionFailure(value: object) {
  if (!("reason" in value) ||
    !["not_quiescent", "in_progress", "cleanup_failed", "storage_failed"].includes(String(value.reason))) {
    return storageFailed()
  }
  return new WorkGraphOwnerDeletionError(value.reason as WorkGraphOwnerDeletionError["reason"])
}

function nonnegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function requireOwner(context: WorkGraphContext) {
  if (context.access.mode !== "owner") throw new WorkGraphOwnerDeletionError("forbidden")
}

function storageFailed() {
  return new WorkGraphOwnerDeletionError("storage_failed")
}
