import { asArray, asRecord } from "@claxedo/helpers/guards"
import type { SignedControlPlaneAuth } from "./auth"
import type { PrivateSessionAuthority, PrivateSessionRuntimePrincipal } from "./private-session-authority"
import type { WorkspaceAuthority } from "./authority"
import { storedSessionShareLevel } from "./session-share-level"
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

export type RuntimeForkReservationConformanceReport = {
  forkReservedUnderAReadableParent: true
  registeredChildIsPrivateToItsCreator: true
  refusedUnderAnUnreadableParent: true
  refusedForAMismatchedIntent: true
}

/**
 * The reservation shape a runtime sends for a child session, on both adapters.
 *
 * A child names a parent, and an intent that names a parent is a `fork` —
 * `sessions`' own CHECK constraint pairs them that way, so the two mismatched
 * pairings below are refused before anything is written. The runtime-principal
 * entrypoint is the one under test: the route reaches it with an actor it took
 * from a verified proof, never from the request body.
 */
export async function exerciseRuntimeForkReservationConformance(
  harness: Pick<PrivateSessionAuthorityConformanceHarness, "authority" | "workspaceId" | "creator" | "participant">,
): Promise<RuntimeForkReservationConformanceReport> {
  const { authority, workspaceId, creator, participant } = harness
  const parentSessionId = "ses_fork_reservation_parent"
  const sessionId = "ses_fork_reservation_child"

  await authority.reserveSession(creator.auth, {
    operationId: "op_fork_reservation_parent",
    sessionId: parentSessionId,
    workspaceId,
    kind: "create",
  })
  await authority.registerRuntimeSession({
    ...creator.runtime,
    operationId: "op_fork_reservation_parent",
    sessionId: parentSessionId,
    workspaceId,
  })

  const reserved = await authority.reserveRuntimeSession(creator.runtime, {
    operationId: "op_fork_reservation_child",
    sessionId,
    workspaceId,
    kind: "fork",
    parentSessionId,
    title: "Reviewer",
  })
  invariant(
    reserved.state === "reserved" && reserved.sessionId === sessionId,
    "a fork under a readable parent was not reserved",
  )
  await authority.registerRuntimeSession({
    ...creator.runtime,
    operationId: "op_fork_reservation_child",
    sessionId,
    workspaceId,
    title: "Reviewer",
  })
  await authority.authorizeRuntimeSession({ ...creator.runtime, sessionId, workspaceId, action: "write" })
  invariant(
    await rejects(() =>
      authority.authorizeRuntimeSession({ ...participant.runtime, sessionId, workspaceId, action: "read" }),
    ),
    "a registered child was readable by a workspace member who is not on it",
  )

  invariant(
    await rejects(() =>
      authority.reserveRuntimeSession(participant.runtime, {
        operationId: "op_fork_reservation_under_private_parent",
        sessionId: "ses_fork_reservation_stranger",
        workspaceId,
        kind: "fork",
        parentSessionId,
      }),
    ),
    "a fork was reserved under a parent its creator cannot read",
  )

  invariant(
    await rejects(() =>
      authority.reserveRuntimeSession(creator.runtime, {
        operationId: "op_fork_reservation_create_with_parent",
        sessionId: "ses_fork_reservation_mismatched",
        workspaceId,
        kind: "create",
        parentSessionId,
      }),
    ),
    "a create intent naming a parent session was reserved",
  )
  invariant(
    await rejects(() =>
      authority.reserveRuntimeSession(creator.runtime, {
        operationId: "op_fork_reservation_parentless_fork",
        sessionId: "ses_fork_reservation_orphan",
        workspaceId,
        kind: "fork",
      }),
    ),
    "a fork intent naming no parent session was reserved",
  )

  return {
    forkReservedUnderAReadableParent: true,
    registeredChildIsPrivateToItsCreator: true,
    refusedUnderAnUnreadableParent: true,
    refusedForAMismatchedIntent: true,
  }
}

export type PrivateSessionAdoptionConformanceHarness = {
  authority: PrivateSessionAuthority
  workspaceId: string
  hostId: string
  /** Records that `hostId` serves `workspaceId` on the owner's behalf, as the adapter's own store spells it. */
  assignHost: () => Promise<void>
  owner: {
    auth: SignedControlPlaneAuth
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  }
  /** A workspace member who may write there but does not own the machine. */
  member: {
    auth: SignedControlPlaneAuth
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  }
}

export type PrivateSessionAdoptionConformanceReport = {
  refusedBeforeAssignment: true
  adoptedForEnrollmentOwner: true
  idempotent: true
  refusedForMember: true
  refusedWhenHeldByAnotherCreator: true
}

/**
 * The adoption contract both adapters answer: a session the host already held
 * becomes the enrollment owner's, once, and nobody else's.
 *
 * Every session id here stands for a transcript created on the machine before
 * remote access existed, so none of them is reserved first — which is the
 * whole point, and why no other action in the port can reach this state.
 */
export async function exercisePrivateSessionAdoptionConformance(
  harness: PrivateSessionAdoptionConformanceHarness,
): Promise<PrivateSessionAdoptionConformanceReport> {
  const { authority, workspaceId, hostId, owner, member } = harness
  const sessionId = "ses_local_before_remote_access"
  const adopt = (
    who: PrivateSessionAdoptionConformanceHarness["owner"],
    id: string,
  ) => authority.adoptRuntimeSession({ ...who.runtime, sessionId: id, workspaceId, hostId })

  invariant(
    await rejects(() => adopt(owner, sessionId)),
    "a host with no assignment adopted a session",
  )
  await harness.assignHost()

  invariant(
    await rejects(() =>
      authority.authorizeRuntimeSession({ ...owner.runtime, sessionId, workspaceId, action: "read" }),
    ),
    "an unregistered session was readable before adoption",
  )
  const adopted = await adopt(owner, sessionId)
  invariant(adopted.adopted, "the enrollment owner's first adoption reported no change")
  await authority.authorizeRuntimeSession({ ...owner.runtime, sessionId, workspaceId, action: "read" })
  await authority.authorizeRuntimeSession({ ...owner.runtime, sessionId, workspaceId, action: "write" })
  invariant(
    asArray(await authority.listSessions(owner.auth, { workspaceId })).some(
      (row) => asRecord(row)?.session_id === sessionId,
    ),
    "an adopted session did not become visible to its creator",
  )
  invariant(
    await rejects(() =>
      authority.authorizeRuntimeSession({ ...member.runtime, sessionId, workspaceId, action: "read" }),
    ),
    "adoption made a private session visible to a workspace member",
  )

  const again = await adopt(owner, sessionId)
  invariant(!again.adopted, "a repeated adoption reported a second registration")
  invariant(
    asArray(await authority.listSessions(owner.auth, { workspaceId })).filter(
      (row) => asRecord(row)?.session_id === sessionId,
    ).length === 1,
    "a repeated adoption produced a second session row",
  )

  invariant(
    await rejects(() => adopt(member, "ses_member_attempt")),
    "a workspace member who does not own the machine adopted a session",
  )

  const held = "ses_created_by_the_member"
  await authority.reserveSession(member.auth, {
    operationId: "op_created_by_the_member",
    sessionId: held,
    workspaceId,
    kind: "create",
  })
  await authority.registerRuntimeSession({
    ...member.runtime,
    operationId: "op_created_by_the_member",
    sessionId: held,
    workspaceId,
  })
  invariant(
    await rejects(() => adopt(owner, held)),
    "adoption claimed a session already registered to another creator",
  )

  return {
    refusedBeforeAssignment: true,
    adoptedForEnrollmentOwner: true,
    idempotent: true,
    refusedForMember: true,
    refusedWhenHeldByAnotherCreator: true,
  }
}

export type SessionShareLevelConformanceHarness = {
  authority: Pick<PrivateSessionAuthority, "authorizeRuntimeSession" | "listSessions">
  /** The share-grant surface, which lives on the workspace authority in both adapters. */
  shares: Pick<WorkspaceAuthority, "grantSessionShare" | "revokeSessionShare" | "listSessionShares">
  workspaceId: string
  /** A session the creator already registered, so only the share decides the grantee's access. */
  sessionId: string
  creator: { auth: SignedControlPlaneAuth }
  /** A workspace member with write access there and no standing on the session. */
  grantee: {
    auth: SignedControlPlaneAuth
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
    /** How this adapter's grant route names the grantee. */
    target: { grantedToTokenIdentifier: string } | { grantedToUserId: string }
  }
  /** Someone the workspace lets read and not write, so `send` cannot be honoured for them. */
  readOnlyRecipient: { target: { grantedToTokenIdentifier: string } | { grantedToUserId: string } }
}

export type SessionShareLevelConformanceReport = {
  defaultsToFollow: true
  followReadsButDoesNotWrite: true
  sendWrites: true
  downgradeEndsWriting: true
  revokeEndsReading: true
  sendRefusedWhereItCouldNotBeHonoured: true
}

/**
 * What a share level means, on whichever store answers the runtime.
 *
 * The runtime never sees a level: it asks for `read` or `write` per request,
 * and the level is what decides the second. So every case here is stated as
 * the runtime's own question, which is what makes the two adapters comparable
 * even though their grant tables are spelled differently.
 */
export async function exerciseSessionShareLevelConformance(
  harness: SessionShareLevelConformanceHarness,
): Promise<SessionShareLevelConformanceReport> {
  const { authority, shares, workspaceId, sessionId, creator, grantee, readOnlyRecipient } = harness
  // Bound rather than called through `shares`: one adapter is a class whose
  // methods read `this`, and the port declares all three optional, so the
  // narrowing has to survive into the closures below.
  const grantShare = shares.grantSessionShare?.bind(shares)
  const revokeShare = shares.revokeSessionShare?.bind(shares)
  const listShares = shares.listSessionShares?.bind(shares)
  invariant(
    grantShare && revokeShare && listShares,
    "the adapter under test does not implement session shares",
  )
  const grant = (level?: "follow" | "send") =>
    grantShare(creator.auth, {
      sessionId,
      workspaceId,
      ...(level ? { level } : {}),
      ...grantee.target,
    })
  const runtime = (action: "read" | "write") =>
    authority.authorizeRuntimeSession({ ...grantee.runtime, sessionId, workspaceId, action })
  const listedLevels = async () => {
    const context = await listShares(creator.auth, { sessionId, workspaceId })
    return context.grants.map((row) => storedSessionShareLevel(row.level)).join()
  }

  invariant(await rejects(() => runtime("read")), "a session was readable before it was shared")

  const first = await grant()
  invariant(first.level === "follow", "a grant that named no level did not default to follow")
  invariant(await listedLevels() === "follow", "the listed grant did not carry its level")
  await runtime("read")
  invariant(await rejects(() => runtime("write")), "a follow grantee was admitted to write")

  const raised = await grant("send")
  invariant(
    raised.grant_id === first.grant_id && raised.level === "send",
    "raising a live grant to send made a second grant",
  )
  invariant(await listedLevels() === "send", "the listed grant did not carry its raised level")
  await runtime("read")
  await runtime("write")

  const lowered = await grant("follow")
  invariant(
    lowered.grant_id === first.grant_id && lowered.level === "follow",
    "lowering a live grant to follow made a second grant",
  )
  await runtime("read")
  invariant(await rejects(() => runtime("write")), "a downgraded grantee kept writing")

  await revokeShare(creator.auth, { sessionId, workspaceId, ...grantee.target })
  invariant(await rejects(() => runtime("read")), "a revoked grantee kept reading")

  const readOnly = (level?: "follow" | "send") =>
    grantShare(creator.auth, {
      sessionId,
      workspaceId,
      ...(level ? { level } : {}),
      ...readOnlyRecipient.target,
    })
  await readOnly()
  invariant(
    await refusesWith(() => readOnly("send"), "session_share_send_workspace_write_required"),
    "send was granted to a recipient whose every write would be refused",
  )
  invariant(
    await listedLevels() === "follow",
    "a refused send grant still moved the recipient's stored level",
  )

  return {
    defaultsToFollow: true,
    followReadsButDoesNotWrite: true,
    sendWrites: true,
    downgradeEndsWriting: true,
    revokeEndsReading: true,
    sendRefusedWhereItCouldNotBeHonoured: true,
  }
}

async function refusesWith(operation: () => Promise<unknown>, code: string) {
  try {
    await operation()
    return false
  } catch (error) {
    return String(error instanceof Error ? error.message : error).includes(code)
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
