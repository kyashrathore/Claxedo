import type { AttemptID, ResolvedExecutionProfile, StreamID, WorkGraphContext, WorkItemID } from "../contracts"
import type { ExecutionLaunch, StreamEnvelope, WorkspaceExecutionPort } from "../ports"

export type AdmittedAttempt = Readonly<{
  attemptId: AttemptID
  streamId: StreamID
  workItemId: WorkItemID
  prompt: string
  profile: ResolvedExecutionProfile
  envelopeId?: StreamEnvelope["id"]
}>

export type AttemptPlacementStore = Readonly<{
  ownsLease: (context: WorkGraphContext, input: Readonly<{ attemptId: AttemptID; workItemId: WorkItemID; leaseEpoch: number }>) => Promise<boolean>
  markPlacing: (context: WorkGraphContext, input: Readonly<{ attemptId: AttemptID; leaseEpoch: number; envelope: StreamEnvelope; childIsolationId?: string }>) => Promise<boolean>
  markRunning: (context: WorkGraphContext, input: Readonly<{ attemptId: AttemptID; leaseEpoch: number; launch: ExecutionLaunch }>) => Promise<boolean>
  markAttention: (context: WorkGraphContext, input: Readonly<{ attemptId: AttemptID; leaseEpoch: number; reason: string }>) => Promise<boolean>
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
  try {
    if (!(await store.ownsLease(context, { attemptId: attempt.attemptId, workItemId: attempt.workItemId, leaseEpoch }))) {
      return { ok: false as const, reason: "Attempt lease ownership was lost before placement" }
    }
    envelope = await execution.provisionOrAdopt(context, {
      streamId: attempt.streamId,
      environment: attempt.profile.environment,
      ...(attempt.profile.repository ? { repository: attempt.profile.repository } : {}),
      ...(attempt.envelopeId ? { envelopeId: attempt.envelopeId } : {}),
    })
    if (!(await store.ownsLease(context, { attemptId: attempt.attemptId, workItemId: attempt.workItemId, leaseEpoch }))) {
      await execution.cleanup(context, { streamId: attempt.streamId, envelopeId: envelope.id, reason: "reconcile" })
      return { ok: false as const, reason: "Attempt lease ownership was lost after provisioning" }
    }
    const child = attempt.profile.isolation === "child"
      ? await execution.createChildIsolation(context, {
          streamId: attempt.streamId,
          envelopeId: envelope.id,
          workItemId: attempt.workItemId,
          attemptId: attempt.attemptId,
        })
      : undefined
    if (!(await store.markPlacing(context, {
      attemptId: attempt.attemptId,
      leaseEpoch,
      envelope,
      ...(child ? { childIsolationId: child.id } : {}),
    }))) {
      await execution.cleanup(context, {
        streamId: attempt.streamId,
        envelopeId: envelope.id,
        ...(child ? { childIsolationIds: [child.id] } : {}),
        reason: "reconcile",
      })
      return { ok: false as const, reason: "Attempt lease ownership was lost before launch" }
    }
    if (!(await store.ownsLease(context, { attemptId: attempt.attemptId, workItemId: attempt.workItemId, leaseEpoch }))) {
      await execution.cleanup(context, {
        streamId: attempt.streamId,
        envelopeId: envelope.id,
        ...(child ? { childIsolationIds: [child.id] } : {}),
        reason: "reconcile",
      })
      return { ok: false as const, reason: "Attempt lease ownership was lost before launch" }
    }
    launch = await execution.launch(context, {
      streamId: attempt.streamId,
      workItemId: attempt.workItemId,
      attemptId: attempt.attemptId,
      envelopeId: envelope.id,
      ...(child ? { childIsolationId: child.id } : {}),
      prompt: attempt.prompt,
      profile: attempt.profile,
      connectionIds: attempt.profile.connectionIds,
    })
    if (!(await store.markRunning(context, { attemptId: attempt.attemptId, leaseEpoch, launch }))) {
      await execution.cancel(context, { attemptId: attempt.attemptId, sessionId: launch.sessionId, reason: "Attempt lease ownership was lost after launch" })
      await execution.cleanup(context, {
        streamId: attempt.streamId,
        envelopeId: envelope.id,
        ...(child ? { childIsolationIds: [child.id] } : {}),
        reason: "reconcile",
      })
      return { ok: false as const, reason: "Attempt lease ownership was lost after launch" }
    }
    return { ok: true as const, launch }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (launch) await execution.cancel(context, { attemptId: attempt.attemptId, sessionId: launch.sessionId, reason }).catch(() => undefined)
    await store.markAttention(context, { attemptId: attempt.attemptId, leaseEpoch, reason })
    return { ok: false as const, reason }
  }
}
