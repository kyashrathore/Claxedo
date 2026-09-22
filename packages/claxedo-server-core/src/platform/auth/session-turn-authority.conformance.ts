import {
  SessionTurnConflictError,
  SessionTurnGrantError,
  SessionTurnLeaseLostError,
  childCompletionTurnIdPrefix,
  type SessionTurnAuthority,
  type SessionTurnGrantErrorCode,
} from "./session-turn-authority"
import type { PrivateSessionAuthority, PrivateSessionRuntimePrincipal } from "./private-session-authority"

export const SESSION_TURN_AUTHORITY_CONFORMANCE_SCENARIOS = [
  "atomic-session-exclusion",
  "idempotent-turn-retry",
  "reconstruction-visibility",
  "expiry-fencing-and-stale-release",
] as const

export type SessionTurnAuthorityConformanceHarness = {
  authority: SessionTurnAuthority
  /** A separately constructed adapter over the same durable backing store. */
  reconstructed: SessionTurnAuthority
  workspaceId: string
  sessionId: string
  actor: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  competitor: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  advancePast(expiresAt: number): void
}

export async function exerciseSessionTurnAuthorityConformance(
  harness: SessionTurnAuthorityConformanceHarness,
) {
  const base = {
    ...harness.actor,
    workspaceId: harness.workspaceId,
    sessionId: harness.sessionId,
    turnId: "msg_turn_1",
  } as const
  const first = await harness.authority.acquireSessionTurn(base)
  invariant(first.fencingToken >= 1, "the first durable turn has no fencing generation")
  invariant(first.expiresAt > first.acquiredAt, "the durable turn lease has no bounded lifetime")

  const retried = await harness.reconstructed.acquireSessionTurn(base)
  invariant(retried.leaseId === first.leaseId, "an exact retry created a second lease")
  invariant(retried.fencingToken === first.fencingToken, "an exact retry advanced the fence")

  const concurrent = await Promise.allSettled([
    harness.authority.acquireSessionTurn({ ...base, turnId: "msg_turn_2" }),
    harness.reconstructed.acquireSessionTurn({
      ...base,
      ...harness.competitor,
      turnId: "msg_turn_3",
    }),
  ])
  invariant(
    concurrent.every((result) => result.status === "rejected" && result.reason instanceof SessionTurnConflictError),
    "a concurrent or reconstructed authority admitted another active turn",
  )

  harness.advancePast(first.expiresAt)
  const replacement = await harness.reconstructed.acquireSessionTurn({ ...base, turnId: "msg_turn_2" })
  invariant(replacement.fencingToken > first.fencingToken, "expiry takeover did not advance the fence")
  invariant(replacement.leaseId !== first.leaseId, "expiry takeover reused the stale ownership secret")

  const staleRelease = await harness.authority.releaseSessionTurn({ ...base, ...first })
  invariant(!staleRelease.released, "a stale lease released its replacement")
  await rejects(
    () => harness.authority.renewSessionTurn({ ...base, ...first }),
    SessionTurnLeaseLostError,
    "a stale lease renewed after replacement",
  )

  const renewed = await harness.reconstructed.renewSessionTurn({ ...base, ...replacement })
  invariant(renewed.leaseId === replacement.leaseId, "renewal changed the ownership secret")
  invariant(renewed.fencingToken === replacement.fencingToken, "renewal advanced the fence")
  const released = await harness.reconstructed.releaseSessionTurn({ ...base, ...replacement })
  invariant(released.released, "the current owner could not release its lease")

  return {
    scenarios: SESSION_TURN_AUTHORITY_CONFORMANCE_SCENARIOS,
    exclusion: { concurrentDenied: true, reconstructionDenied: true },
    retry: { idempotent: true },
    recovery: { expiryTakeover: true, staleReleaseFenced: true },
  } as const
}

async function rejects(
  operation: () => Promise<unknown>,
  expected: new (...args: never[]) => Error,
  message: string,
) {
  try {
    await operation()
  } catch (error) {
    invariant(error instanceof expected, message)
    return
  }
  throw new Error(message)
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Session-turn authority conformance failed: ${message}`)
}

export const SESSION_TURN_GRANT_CONFORMANCE_SCENARIOS = [
  "grant-under-send-share",
  "redeem-mints-lease-and-producer",
  "same-turn-retry-returns-the-live-lease",
  "redeemed-grant-refused-after-release",
  "turn-id-and-prefix-mismatch-refused",
  "wrong-actor-refused",
  "expired-refused",
  "downgraded-share-refused-without-lease-or-producer",
  "revoked-refused",
  "reconstruction-visibility",
] as const

export type SessionTurnGrantConformanceHarness = {
  authority: SessionTurnAuthority
  /** A separately constructed adapter over the same durable backing store. */
  reconstructed: SessionTurnAuthority
  registrations: Pick<PrivateSessionAuthority, "reserveRuntimeSession" | "registerRuntimeSession">
  workspaceId: string
  /** The parent session `creator` registered; every grant targets it. */
  sessionId: string
  creator: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  /**
   * Holds no standing on the session beyond the share `setGranteeShare`
   * writes, and enough workspace rank to fork a child under the parent.
   */
  grantee: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  setGranteeShare(level: "follow" | "send" | null): Promise<void>
  turnProducer(turnId: string): Promise<{ actorId: string } | undefined>
  advancePast(expiresAt: number): void
}

export async function exerciseSessionTurnGrantConformance(harness: SessionTurnGrantConformanceHarness) {
  const { workspaceId, sessionId } = harness
  const grantee = { ...harness.grantee, workspaceId, sessionId } as const
  const creator = { ...harness.creator, workspaceId, sessionId } as const
  const childSessionId = "ses_grant_child"
  const childOperationId = "op_grant_child"

  await harness.setGranteeShare("send")
  await harness.registrations.reserveRuntimeSession(harness.grantee, {
    operationId: childOperationId,
    sessionId: childSessionId,
    workspaceId,
    kind: "fork",
    parentSessionId: sessionId,
  })
  await harness.registrations.registerRuntimeSession({
    ...harness.grantee,
    operationId: childOperationId,
    sessionId: childSessionId,
    workspaceId,
  })

  await rejectsGrant(
    () => harness.authority.grantSessionTurn({ ...creator, intent: "child_completion", subjectSessionId: childSessionId, registrationOperationId: childOperationId }),
    "session_turn_grant_mismatch",
    "a child-completion grant was minted for someone other than the child's creator",
  )
  await rejectsGrant(
    () => harness.authority.grantSessionTurn({ ...grantee, intent: "child_completion", subjectSessionId: childSessionId, registrationOperationId: "op_grant_unknown" }),
    "session_turn_grant_mismatch",
    "a child-completion grant was minted without its registration row",
  )
  await rejectsGrant(
    () => harness.authority.grantSessionTurn({ ...grantee, intent: "queued_prompt" }),
    "session_turn_grant_invalid",
    "a queued-prompt grant was minted without the turn id fixed at queue time",
  )
  await harness.setGranteeShare("follow")
  await rejects(
    () => harness.authority.grantSessionTurn({ ...grantee, intent: "queued_prompt", turnId: "msg_follow_only" }),
    Error,
    "a follow-only grantee minted a grant",
  )
  await harness.setGranteeShare("send")

  const wake = await harness.authority.grantSessionTurn({
    ...grantee,
    intent: "child_completion",
    subjectSessionId: childSessionId,
    registrationOperationId: childOperationId,
  })
  invariant(wake.turnIdPrefix === childCompletionTurnIdPrefix(childSessionId), "a child-completion grant does not carry the wake turn-id prefix")
  invariant(wake.turnId === undefined, "a child-completion grant fixed an exact turn id")
  invariant(wake.actorId === harness.grantee.actorId && wake.sessionId === sessionId, "the grant names another actor or session")
  invariant(wake.expiresAt > wake.issuedAt, "the grant has no bounded lifetime")
  invariant(wake.redeemedAt === undefined && wake.revokedAt === undefined, "a fresh grant is already consumed")

  const wakeTurnId = `${wake.turnIdPrefix}1`
  const admitted = await harness.reconstructed.acquireSessionTurn({ ...grantee, turnId: wakeTurnId, grantId: wake.grantId })
  invariant(admitted.turnId === wakeTurnId && admitted.fencingToken >= 1, "redeeming the grant did not admit the turn")
  invariant((await harness.turnProducer(wakeTurnId))?.actorId === harness.grantee.actorId, "the redeemed turn has no producer row for the grant's actor")

  const retried = await harness.authority.acquireSessionTurn({ ...grantee, turnId: wakeTurnId, grantId: wake.grantId })
  invariant(retried.leaseId === admitted.leaseId && retried.fencingToken === admitted.fencingToken, "a same-turn retry with the grant did not return the live lease")

  const released = await harness.authority.releaseSessionTurn({ ...grantee, ...admitted })
  invariant(released.released, "the grant's actor could not release the admitted lease")
  await rejectsGrant(
    () => harness.authority.acquireSessionTurn({ ...grantee, turnId: wakeTurnId, grantId: wake.grantId }),
    "session_turn_grant_redeemed",
    "a redeemed grant admitted its turn again after release",
  )
  await rejectsGrant(
    () => harness.reconstructed.acquireSessionTurn({ ...grantee, turnId: `${wake.turnIdPrefix}2`, grantId: wake.grantId }),
    "session_turn_grant_redeemed",
    "a redeemed grant admitted another turn under its prefix",
  )
  invariant(await harness.turnProducer(`${wake.turnIdPrefix}2`) === undefined, "a refused redemption wrote a producer row")

  const second = await harness.authority.grantSessionTurn({
    ...grantee,
    intent: "child_completion",
    subjectSessionId: childSessionId,
    registrationOperationId: childOperationId,
  })
  const secondTurnId = `${second.turnIdPrefix}3`
  await rejectsGrant(
    () => harness.authority.acquireSessionTurn({ ...grantee, turnId: "msg_outside_prefix", grantId: second.grantId }),
    "session_turn_grant_mismatch",
    "a prefix grant admitted a turn outside its prefix",
  )
  await rejectsGrant(
    () => harness.authority.acquireSessionTurn({ ...creator, turnId: secondTurnId, grantId: second.grantId }),
    "session_turn_grant_mismatch",
    "another actor with a turn of their own redeemed the grantee's grant",
  )
  await rejectsGrant(
    () => harness.authority.acquireSessionTurn({ ...grantee, turnId: secondTurnId, grantId: "grant_unknown" }),
    "session_turn_grant_invalid",
    "an unknown grant id admitted a turn",
  )
  invariant(await harness.turnProducer(secondTurnId) === undefined, "a refused redemption wrote a producer row")
  harness.advancePast(second.expiresAt)
  await rejectsGrant(
    () => harness.reconstructed.acquireSessionTurn({ ...grantee, turnId: secondTurnId, grantId: second.grantId }),
    "session_turn_grant_expired",
    "an expired grant admitted a turn",
  )

  const queued = await harness.authority.grantSessionTurn({ ...grantee, intent: "queued_prompt", turnId: "msg_queued_1" })
  invariant(queued.turnId === "msg_queued_1" && queued.turnIdPrefix === undefined, "a queued-prompt grant does not fix its turn id")
  await rejectsGrant(
    () => harness.authority.acquireSessionTurn({ ...grantee, turnId: "msg_queued_2", grantId: queued.grantId }),
    "session_turn_grant_mismatch",
    "an exact-turn grant admitted another turn id",
  )
  await harness.setGranteeShare("follow")
  await rejects(
    () => harness.reconstructed.acquireSessionTurn({ ...grantee, turnId: "msg_queued_1", grantId: queued.grantId }),
    Error,
    "a grant admitted a turn after the share was downgraded",
  )
  invariant(await harness.turnProducer("msg_queued_1") === undefined, "a refused redemption under a downgraded share wrote a producer row")
  await harness.setGranteeShare("send")
  const probe = await harness.authority.acquireSessionTurn({ ...creator, turnId: "msg_creator_probe" })
  await harness.authority.releaseSessionTurn({ ...creator, ...probe })
  const admittedQueued = await harness.reconstructed.acquireSessionTurn({ ...grantee, turnId: "msg_queued_1", grantId: queued.grantId })
  invariant(admittedQueued.fencingToken > probe.fencingToken, "the refused redemption left a lease behind")
  invariant((await harness.turnProducer("msg_queued_1"))?.actorId === harness.grantee.actorId, "the queued turn has no producer row for the grant's actor")
  await harness.reconstructed.releaseSessionTurn({ ...grantee, ...admittedQueued })

  const revokedBySession = await harness.authority.grantSessionTurn({ ...grantee, intent: "queued_prompt", turnId: "msg_queued_revoked" })
  const revokedByChild = await harness.authority.grantSessionTurn({
    ...grantee,
    intent: "child_completion",
    subjectSessionId: childSessionId,
    registrationOperationId: childOperationId,
  })
  const bySubject = await harness.authority.revokeSessionTurnGrants({ subjectSessionId: childSessionId, reason: "child compensated" })
  invariant(bySubject.revoked === 3, `revoking by subject session revoked ${bySubject.revoked} grants instead of the three child grants minted so far`)
  const bySession = await harness.reconstructed.revokeSessionTurnGrants({ sessionId, reason: "session deleted" })
  invariant(bySession.revoked === 2, `revoking by session revoked ${bySession.revoked} grants instead of the two queued-prompt grants the child revocation left`)
  await rejectsGrant(
    () => harness.authority.acquireSessionTurn({ ...grantee, turnId: "msg_queued_revoked", grantId: revokedBySession.grantId }),
    "session_turn_grant_revoked",
    "a grant revoked by session admitted a turn",
  )
  await rejectsGrant(
    () => harness.reconstructed.acquireSessionTurn({ ...grantee, turnId: `${revokedByChild.turnIdPrefix}1`, grantId: revokedByChild.grantId }),
    "session_turn_grant_revoked",
    "a grant revoked by subject session admitted a turn",
  )

  return {
    scenarios: SESSION_TURN_GRANT_CONFORMANCE_SCENARIOS,
    grant: { requiresSendShare: true, requiresChildRegistration: true },
    redemption: { leaseAndProducer: true, sameTurnRetry: true, refusedAfterRelease: true },
    refusals: { mismatch: true, wrongActor: true, expired: true, downgradedShare: true, revoked: true },
    reconstruction: { visible: true },
  } as const
}

async function rejectsGrant(
  operation: () => Promise<unknown>,
  code: SessionTurnGrantErrorCode,
  message: string,
) {
  try {
    await operation()
  } catch (error) {
    invariant(
      error instanceof SessionTurnGrantError && error.code === code,
      `${message} (expected ${code}, got ${error instanceof Error ? `${error.name}${"code" in error ? ` ${String(error.code)}` : ""}` : String(error)})`,
    )
    return
  }
  throw new Error(message)
}
