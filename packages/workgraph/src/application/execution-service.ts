import {
  resolvedPlacement,
  type RunID,
  type ResolvedExecutionProfile,
  type StreamID,
  type WorkGraphContext,
  type WorkItemID,
} from "../contracts"
import type {
  ChildIsolationID,
  ExecutionLaunch,
  ExecutionSessionID,
  StreamEnvelope,
  StreamEnvelopeID,
  WorkspaceExecutionPort,
} from "../ports"
import { childIsolationIdForRun } from "../ports"

export type AdmittedRun = Readonly<{
  runId: RunID
  streamId: StreamID
  parentStreamId?: StreamID
  workItemId: WorkItemID
  title: string
  prompt: string
  profile: ResolvedExecutionProfile
  envelopeId?: StreamEnvelope["id"]
}>

export type RunPlacementStore = Readonly<{
  ownsLease: (
    context: WorkGraphContext,
    input: Readonly<{ runId: RunID; workItemId: WorkItemID; leaseEpoch: number }>,
  ) => Promise<boolean>
  markPlacing: (
    context: WorkGraphContext,
    input: Readonly<{ runId: RunID; leaseEpoch: number; envelope: StreamEnvelope; childIsolationId?: string }>,
  ) => Promise<boolean>
  markRunning: (
    context: WorkGraphContext,
    input: Readonly<{ runId: RunID; leaseEpoch: number; launch: ExecutionLaunch }>,
  ) => Promise<boolean>
  markParked: (
    context: WorkGraphContext,
    input: Readonly<{ runId: RunID; leaseEpoch: number; reason: string }>,
  ) => Promise<boolean>
  placementCompensation: Readonly<{
    reserve: (context: WorkGraphContext, input: PlacementCompensation) => Promise<string>
    complete: (context: WorkGraphContext, input: Readonly<{ key: string }>) => Promise<void>
    fail: (context: WorkGraphContext, input: Readonly<{ key: string; reason: string }>) => Promise<void>
  }>
}>

export type PlacementCompensation = Readonly<{
  runId: RunID
  streamId: StreamID
  workItemId: WorkItemID
  leaseEpoch: number
  envelopeId: StreamEnvelopeID
  childIsolationId?: ChildIsolationID
  sessionId?: ExecutionSessionID
  reason: string
}>

/** Places one already-durable Run. Admission remains a separate atomic store operation. */
export async function placeAdmittedRun(
  context: WorkGraphContext,
  run: AdmittedRun,
  store: RunPlacementStore,
  execution: WorkspaceExecutionPort,
  leaseEpoch = 1,
) {
  let envelope: StreamEnvelope | undefined
  let launch: ExecutionLaunch | undefined
  const placement = await (async () => {
    try {
      if (
        !(await store.ownsLease(context, { runId: run.runId, workItemId: run.workItemId, leaseEpoch }))
      ) {
        return { ok: false as const, reason: "Run lease ownership was lost before placement" }
      }
      envelope = await execution.provisionOrAdopt(context, {
        streamId: run.streamId,
        ...(run.parentStreamId ? { parentStreamId: run.parentStreamId } : {}),
        environment: run.profile.environment,
        ...(run.profile.repository ? { repository: run.profile.repository } : {}),
        ...(run.envelopeId ? { envelopeId: run.envelopeId } : {}),
      })
      if (
        !(await store.ownsLease(context, { runId: run.runId, workItemId: run.workItemId, leaseEpoch }))
      ) {
        return { ok: false as const, reason: "Run lease ownership was lost after provisioning" }
      }
      if (
        !(await store.markPlacing(context, {
          runId: run.runId,
          leaseEpoch,
          envelope,
          ...(resolvedPlacement(run.profile.environment.placement) === "shared"
            ? {}
            : { childIsolationId: childIsolationIdForRun(run.runId) }),
        }))
      ) {
        return { ok: false as const, reason: "Run lease ownership was lost before launch" }
      }
      if (
        !(await store.ownsLease(context, { runId: run.runId, workItemId: run.workItemId, leaseEpoch }))
      ) {
        return { ok: false as const, reason: "Run lease ownership was lost before launch" }
      }
      launch = await execution.launch(context, {
        streamId: run.streamId,
        workItemId: run.workItemId,
        title: run.title,
        runId: run.runId,
        leaseEpoch,
        envelopeId: envelope.id,
        workspaceId: envelope.workspaceId,
        ...(resolvedPlacement(run.profile.environment.placement) === "shared"
          ? {}
          : { childIsolationId: childIsolationIdForRun(run.runId) }),
        prompt: run.prompt,
        profile: run.profile,
        connectionIds: run.profile.connectionIds,
      })
      if (!(await store.markRunning(context, { runId: run.runId, leaseEpoch, launch }))) {
        return { ok: false as const, reason: "Run lease ownership was lost after launch" }
      }
      return { ok: true as const, launch }
    } catch (error) {
      return { ok: false as const, reason: errorMessage(error) }
    }
  })()
  if (placement.ok) return placement
  if (!envelope) {
    await store.markParked(context, { runId: run.runId, leaseEpoch, reason: placement.reason })
    return placement
  }
  if (!launch) {
    await store.markParked(context, { runId: run.runId, leaseEpoch, reason: placement.reason })
    return placement
  }
  const compensation = {
    runId: run.runId,
    streamId: run.streamId,
    workItemId: run.workItemId,
    leaseEpoch,
    envelopeId: envelope.id,
    ...(launch.childIsolationId ? { childIsolationId: launch.childIsolationId } : {}),
    sessionId: launch.sessionId,
    reason: placement.reason,
  }
  const key = await store.placementCompensation.reserve(context, compensation)
  const effects = await Promise.allSettled([
    execution.cancel(context, {
      runId: run.runId,
      sessionId: launch.sessionId,
      reason: placement.reason,
    }),
    ...(launch.childIsolationId
      ? [execution.cleanup(context, {
          streamId: run.streamId,
          envelopeId: envelope.id,
          childIsolationIds: [launch.childIsolationId],
          reason: "reconcile",
        })]
      : []),
  ])
  const failures = effects.flatMap((effect) =>
    effect.status === "rejected"
      ? [`Session cancellation failed: ${errorMessage(effect.reason)}`]
      : [],
  )
  const reason = [placement.reason, ...failures].join("; ")
  if (failures.length > 0) await store.placementCompensation.fail(context, { key, reason })
  if (failures.length === 0) await store.placementCompensation.complete(context, { key })
  await store.markParked(context, { runId: run.runId, leaseEpoch, reason })
  return { ok: false as const, reason }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
