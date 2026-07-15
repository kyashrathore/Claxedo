import type { AttemptID, ResolvedExecutionProfile, StreamID, WorkGraphContext, WorkItemID } from "../contracts"
import type {
  ChildIsolationID,
  ExecutionLaunch,
  ExecutionSessionID,
  StreamEnvelope,
  StreamEnvelopeID,
  WorkspaceExecutionPort,
} from "../ports"

export type AdmittedAttempt = Readonly<{
  attemptId: AttemptID
  streamId: StreamID
  workItemId: WorkItemID
  prompt: string
  profile: ResolvedExecutionProfile
  envelopeId?: StreamEnvelope["id"]
}>

export type AttemptPlacementStore = Readonly<{
  ownsLease: (
    context: WorkGraphContext,
    input: Readonly<{ attemptId: AttemptID; workItemId: WorkItemID; leaseEpoch: number }>,
  ) => Promise<boolean>
  markPlacing: (
    context: WorkGraphContext,
    input: Readonly<{ attemptId: AttemptID; leaseEpoch: number; envelope: StreamEnvelope; childIsolationId?: string }>,
  ) => Promise<boolean>
  markRunning: (
    context: WorkGraphContext,
    input: Readonly<{ attemptId: AttemptID; leaseEpoch: number; launch: ExecutionLaunch }>,
  ) => Promise<boolean>
  markAttention: (
    context: WorkGraphContext,
    input: Readonly<{ attemptId: AttemptID; leaseEpoch: number; reason: string }>,
  ) => Promise<boolean>
  placementCompensation: Readonly<{
    reserve: (context: WorkGraphContext, input: PlacementCompensation) => Promise<string>
    complete: (context: WorkGraphContext, input: Readonly<{ key: string }>) => Promise<void>
    fail: (context: WorkGraphContext, input: Readonly<{ key: string; reason: string }>) => Promise<void>
  }>
}>

export type PlacementCompensation = Readonly<{
  attemptId: AttemptID
  streamId: StreamID
  workItemId: WorkItemID
  leaseEpoch: number
  envelopeId: StreamEnvelopeID
  childIsolationId?: ChildIsolationID
  sessionId?: ExecutionSessionID
  reason: string
}>

/** Places one already-durable Attempt. Admission remains a separate atomic store operation. */
export async function placeAdmittedAttempt(
  context: WorkGraphContext,
  attempt: AdmittedAttempt,
  store: AttemptPlacementStore,
  execution: WorkspaceExecutionPort,
  leaseEpoch = 1,
) {
  let envelope: StreamEnvelope | undefined
  let launch: ExecutionLaunch | undefined
  const placement = await (async () => {
    try {
      if (
        !(await store.ownsLease(context, { attemptId: attempt.attemptId, workItemId: attempt.workItemId, leaseEpoch }))
      ) {
        return { ok: false as const, reason: "Attempt lease ownership was lost before placement" }
      }
      envelope = await execution.provisionOrAdopt(context, {
        streamId: attempt.streamId,
        environment: attempt.profile.environment,
        ...(attempt.profile.repository ? { repository: attempt.profile.repository } : {}),
        ...(attempt.envelopeId ? { envelopeId: attempt.envelopeId } : {}),
      })
      if (
        !(await store.ownsLease(context, { attemptId: attempt.attemptId, workItemId: attempt.workItemId, leaseEpoch }))
      ) {
        return { ok: false as const, reason: "Attempt lease ownership was lost after provisioning" }
      }
      if (
        !(await store.markPlacing(context, {
          attemptId: attempt.attemptId,
          leaseEpoch,
          envelope,
        }))
      ) {
        return { ok: false as const, reason: "Attempt lease ownership was lost before launch" }
      }
      if (
        !(await store.ownsLease(context, { attemptId: attempt.attemptId, workItemId: attempt.workItemId, leaseEpoch }))
      ) {
        return { ok: false as const, reason: "Attempt lease ownership was lost before launch" }
      }
      launch = await execution.launch(context, {
        streamId: attempt.streamId,
        workItemId: attempt.workItemId,
        attemptId: attempt.attemptId,
        leaseEpoch,
        envelopeId: envelope.id,
        workspaceId: envelope.workspaceId,
        prompt: attempt.prompt,
        profile: attempt.profile,
        connectionIds: attempt.profile.connectionIds,
      })
      if (!(await store.markRunning(context, { attemptId: attempt.attemptId, leaseEpoch, launch }))) {
        return { ok: false as const, reason: "Attempt lease ownership was lost after launch" }
      }
      return { ok: true as const, launch }
    } catch (error) {
      return { ok: false as const, reason: errorMessage(error) }
    }
  })()
  if (placement.ok) return placement
  if (!envelope) {
    await store.markAttention(context, { attemptId: attempt.attemptId, leaseEpoch, reason: placement.reason })
    return placement
  }
  if (!launch) {
    await store.markAttention(context, { attemptId: attempt.attemptId, leaseEpoch, reason: placement.reason })
    return placement
  }
  const compensation = {
    attemptId: attempt.attemptId,
    streamId: attempt.streamId,
    workItemId: attempt.workItemId,
    leaseEpoch,
    envelopeId: envelope.id,
    sessionId: launch.sessionId,
    reason: placement.reason,
  }
  const key = await store.placementCompensation.reserve(context, compensation)
  const effects = await Promise.allSettled([
    execution.cancel(context, {
      attemptId: attempt.attemptId,
      sessionId: launch.sessionId,
      reason: placement.reason,
    }),
  ])
  const failures = effects.flatMap((effect) =>
    effect.status === "rejected"
      ? [`Session cancellation failed: ${errorMessage(effect.reason)}`]
      : [],
  )
  const reason = [placement.reason, ...failures].join("; ")
  if (failures.length > 0) await store.placementCompensation.fail(context, { key, reason })
  if (failures.length === 0) await store.placementCompensation.complete(context, { key })
  await store.markAttention(context, { attemptId: attempt.attemptId, leaseEpoch, reason })
  return { ok: false as const, reason }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
