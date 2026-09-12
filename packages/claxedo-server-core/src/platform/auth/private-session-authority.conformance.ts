import { asArray, asRecord } from "@claxedo/helpers/guards"
import type { SignedControlPlaneAuth } from "./auth"
import type { PrivateSessionAuthority, PrivateSessionRuntimePrincipal } from "./private-session-authority"
import type { SessionTurnAuthority } from "./session-turn-authority"

export const PRIVATE_SESSION_AUTHORITY_CONFORMANCE_SCENARIOS = [
  "reservation-reconciliation-compensation",
  "workspace-and-private-session-conjunction",
  "canonical-actor-attribution",
  "explicit-runtime-principal",
] as const

export type PrivateSessionAuthorityConformanceHarness = {
  authority: PrivateSessionAuthority
  turnAuthority?: SessionTurnAuthority
  workspaceId: string
  creator: {
    auth: SignedControlPlaneAuth
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  }
  participant: {
    auth: SignedControlPlaneAuth
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  }
}

export type PrivateSessionAuthorityConformanceReport = {
  scenarios: typeof PRIVATE_SESSION_AUTHORITY_CONFORMANCE_SCENARIOS
  lifecycle: {
    reserved: true
    reconciled: true
    compensated: true
    released: true
  }
  access: {
    deniedBeforeGrant: true
    allowedAfterGrant: true
    deniedAfterRevoke: true
  }
  attribution: {
    canonicalActorPreserved: true
    forgedActorRemoved: true
  }
}

/**
 * Reusable behavioral surface for every private-session adapter. It uses only
 * the provider-neutral port and canonical actor ids; provider subjects and
 * adapter inspection hooks are intentionally unavailable to the suite.
 */
export async function exercisePrivateSessionAuthorityConformance(
  harness: PrivateSessionAuthorityConformanceHarness,
): Promise<PrivateSessionAuthorityConformanceReport> {
  const { authority, workspaceId, creator, participant } = harness
  const sessionId = "ses_private_session_contract"
  const operationId = "op_private_session_contract"

  const reserved = await authority.reserveSession(creator.auth, {
    operationId,
    sessionId,
    workspaceId,
    kind: "create",
    title: "provider-neutral contract",
  })
  invariant(reserved.state === "reserved" && reserved.changed, "reservation did not enter reserved state")
  const retried = await authority.reserveSession(creator.auth, {
    operationId,
    sessionId,
    workspaceId,
    kind: "create",
    title: "provider-neutral contract",
  })
  invariant(
    !retried.changed && retried.state === "reserved" && retried.sessionId === sessionId,
    "an unchanged reservation retry was not idempotent",
  )
  invariant(
    asArray(await authority.listSessions(creator.auth, { workspaceId })).length === 0,
    "a reservation became visible before runtime registration",
  )

  const ambiguous = await authority.markSessionRegistrationAmbiguous({
    ...creator.runtime,
    operationId,
    sessionId,
    workspaceId,
    reason: "runtime outcome was not observed",
  })
  invariant(ambiguous.state === "reconciliation_required", "ambiguous registration did not require reconciliation")
  await authority.registerRuntimeSession({
    ...creator.runtime,
    operationId,
    sessionId,
    workspaceId,
    title: "provider-neutral contract",
  })
  invariant(
    asArray(await authority.listSessions(creator.auth, { workspaceId })).some(
      (row) => asRecord(row)?.session_id === sessionId,
    ),
    "exact registration retry did not reconcile the session",
  )

  await authority.authorizeSessionRead(creator.auth, { sessionId, workspaceId })
  await authority.authorizeSessionWrite(creator.auth, { sessionId, workspaceId })
  await authority.authorizeRuntimeSession({
    ...creator.runtime,
    sessionId,
    workspaceId,
    action: "write",
  })

  const deniedBeforeGrant = await rejects(() =>
    authority.authorizeSessionRead(participant.auth, { sessionId, workspaceId }),
  )
  invariant(deniedBeforeGrant, "workspace authority alone exposed a private session")

  const grant = await authority.grantSessionParticipant(creator.auth, {
    sessionId,
    workspaceId,
    participantActorId: participant.runtime.actorId,
  })
  invariant(grant.participant_id === participant.runtime.actorId, "participant grant returned a different actor")
  await authority.authorizeSessionRead(participant.auth, { sessionId, workspaceId })
  await authority.authorizeRuntimeSession({
    ...participant.runtime,
    sessionId,
    workspaceId,
    action: "read",
  })

  let fencingToken: number | undefined
  if (harness.turnAuthority) {
    for (const turnId of ["message_canonical_actor", "message_forged_actor"]) {
      const lease = await harness.turnAuthority.acquireSessionTurn({
        ...participant.runtime,
        sessionId,
        workspaceId,
        turnId,
      })
      fencingToken = lease.fencingToken
      await harness.turnAuthority.releaseSessionTurn({
        ...participant.runtime,
        sessionId,
        workspaceId,
        turnId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      })
    }
  }
  await authority.syncSessionMessages(participant.auth, {
    sessionId,
    workspaceId,
    maxEventOrdinal: 1,
    ...(fencingToken === undefined ? {} : { fencingToken }),
    messages: [
      {
        info: {
          id: "message_canonical_actor",
          role: "user",
          claxedo: {
            author: {
              id: participant.runtime.actorId,
              kind: "human",
              name: "untrusted display name",
            },
          },
        },
        parts: [],
      },
      {
        info: {
          id: "message_forged_actor",
          role: "user",
          claxedo: { author: { id: creator.runtime.actorId, kind: "human" } },
        },
        parts: [],
      },
    ],
  })
  const page = asRecord(await authority.readSessionMessages(creator.auth, { sessionId, workspaceId }))
  const messages = asArray(page?.messages)
  const canonical = messages.map(asRecord).find((message) => asRecord(message?.info)?.id === "message_canonical_actor")
  const forged = messages.map(asRecord).find((message) => asRecord(message?.info)?.id === "message_forged_actor")
  const canonicalAuthor = asRecord(asRecord(asRecord(canonical?.info)?.claxedo)?.author)
  const forgedAuthor = asRecord(asRecord(asRecord(forged?.info)?.claxedo)?.author)
  invariant(
    canonicalAuthor?.id === participant.runtime.actorId &&
      canonicalAuthor.kind === participant.runtime.actorKind &&
      canonicalAuthor.name === undefined,
    "canonical actor attribution trusted caller-supplied display metadata",
  )
  invariant(
    harness.turnAuthority
      ? forgedAuthor?.id === participant.runtime.actorId && forgedAuthor.kind === participant.runtime.actorKind
      : forgedAuthor === undefined,
    "message projection preserved a forged actor",
  )

  const revoked = await authority.revokeSessionParticipant(creator.auth, {
    sessionId,
    workspaceId,
    participantActorId: participant.runtime.actorId,
  })
  invariant(revoked.removed, "active participant was not revoked")
  const deniedAfterRevoke = await rejects(() =>
    authority.authorizeRuntimeSession({
      ...participant.runtime,
      sessionId,
      workspaceId,
      action: "read",
    }),
  )
  invariant(deniedAfterRevoke, "revoked participant retained runtime session authority")

  const compensatedSessionId = "ses_private_session_compensation_contract"
  const compensatedOperationId = "op_private_session_compensation_contract"
  await authority.reserveSession(creator.auth, {
    operationId: compensatedOperationId,
    sessionId: compensatedSessionId,
    workspaceId,
    kind: "create",
  })
  const pending = await authority.beginSessionCompensation({
    ...creator.runtime,
    operationId: compensatedOperationId,
    sessionId: compensatedSessionId,
    workspaceId,
    reason: "runtime definitively rejected create",
  })
  invariant(pending.state === "compensation_pending", "definitive denial did not begin compensation")
  invariant(
    await rejects(() =>
      authority.registerRuntimeSession({
        ...creator.runtime,
        operationId: compensatedOperationId,
        sessionId: compensatedSessionId,
        workspaceId,
      }),
    ),
    "a compensating reservation was registered",
  )
  const compensated = await authority.completeSessionCompensation({
    ...creator.runtime,
    operationId: compensatedOperationId,
    sessionId: compensatedSessionId,
    workspaceId,
    reason: "runtime deletion confirmed",
  })
  invariant(compensated.state === "compensated", "compensation did not reach its terminal state")

  const releasedOperationId = `${compensatedOperationId}_after_release`
  const released = await authority.reserveSession(creator.auth, {
    operationId: releasedOperationId,
    sessionId: compensatedSessionId,
    workspaceId,
    kind: "create",
  })
  invariant(
    released.changed && released.state === "reserved" && released.sessionId === compensatedSessionId,
    "a completed compensation kept holding its session identifier",
  )

  const releasedAgain = {
    ...creator.runtime,
    operationId: releasedOperationId,
    sessionId: compensatedSessionId,
    workspaceId,
    reason: "the session created for the retry was removed again",
  }
  await authority.beginSessionCompensation(releasedAgain)
  await authority.completeSessionCompensation(releasedAgain)
  const restarted = await authority.reserveSession(creator.auth, {
    operationId: releasedOperationId,
    sessionId: compensatedSessionId,
    workspaceId,
    kind: "create",
  })
  invariant(
    restarted.changed && restarted.state === "reserved",
    "a compensated operation could not be reserved again under its own identifier",
  )

  const pendingSessionId = "ses_private_session_compensation_pending_contract"
  const pendingOperationId = "op_private_session_compensation_pending_contract"
  await authority.reserveSession(creator.auth, {
    operationId: pendingOperationId,
    sessionId: pendingSessionId,
    workspaceId,
    kind: "create",
  })
  await authority.beginSessionCompensation({
    ...creator.runtime,
    operationId: pendingOperationId,
    sessionId: pendingSessionId,
    workspaceId,
    reason: "runtime deletion was requested",
  })
  invariant(
    await rejects(() =>
      authority.reserveSession(creator.auth, {
        operationId: `${pendingOperationId}_while_pending`,
        sessionId: pendingSessionId,
        workspaceId,
        kind: "create",
      }),
    ),
    "a compensation that had only begun released its session identifier",
  )

  return {
    scenarios: PRIVATE_SESSION_AUTHORITY_CONFORMANCE_SCENARIOS,
    lifecycle: { reserved: true, reconciled: true, compensated: true, released: true },
    access: { deniedBeforeGrant: true, allowedAfterGrant: true, deniedAfterRevoke: true },
    attribution: { canonicalActorPreserved: true, forgedActorRemoved: true },
  }
}

async function rejects(operation: () => Promise<unknown>) {
  try {
    await operation()
    return false
  } catch {
    return true
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Private-session authority conformance failed: ${message}`)
}
