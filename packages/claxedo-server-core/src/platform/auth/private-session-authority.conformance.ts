import { asArray, asRecord } from "@claxedo/helpers/guards"
import type { SignedControlPlaneAuth } from "./auth"
import type { PrivateSessionAuthority, PrivateSessionRuntimePrincipal } from "./private-session-authority"
import type { WorkspaceAuthority } from "./authority"
import { invariant, refusesWith, rejects } from "./private-session-conformance-checks"
import type { SessionTurnAuthority } from "./session-turn-authority"

/**
 * Session times as a runtime reports them, far behind any authority clock, so
 * a listed row stamped by the authority instead can never match.
 */
const RUNTIME_TIMES = {
  registered: { createdAt: 500, updatedAt: 1_000 },
  synced: 2_000,
  adopted: { createdAt: 2_500, updatedAt: 3_000 },
} as const

async function listedTimes(authority: PrivateSessionAuthority, auth: SignedControlPlaneAuth, workspaceId: string, sessionId: string) {
  const rows = asArray(await authority.listSessions(auth, { workspaceId })).map(asRecord)
  const row = rows.find((candidate) => candidate?.session_id === sessionId)
  return { createdAt: row?.created_at, updatedAt: row?.updated_at }
}

export const PRIVATE_SESSION_AUTHORITY_CONFORMANCE_SCENARIOS = [
  "reservation-reconciliation-compensation",
  "workspace-and-private-session-conjunction",
  "canonical-actor-attribution",
  "explicit-runtime-principal",
] as const

export type PrivateSessionAuthorityConformanceHarness = {
  authority: PrivateSessionAuthority
  turnAuthority?: SessionTurnAuthority
  setWorkspaceAvailable(available: boolean): Promise<void>
  workspaceId: string
  /** The workspace's owner, and so the only person who may create a session in it. */
  creator: {
    auth: SignedControlPlaneAuth
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  }
  /**
   * A member of the workspace's organization holding a project role on it,
   * who does not own the workspace and holds no share.
   */
  member: {
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
    memberRefusedTheSession: true
    memberRefusedCreation: true
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
  const { authority, workspaceId, creator, member } = harness
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

  const startInput = { ...creator.runtime, workspaceId, sessionId, registrationOperationId: operationId }
  await authority.authorizeRuntimeSessionStartStatus(startInput)
  await authority.authorizeRuntimeSessionStart(startInput)
  await harness.setWorkspaceAvailable(false)
  try {
    invariant(await rejects(() => authority.authorizeRuntimeSessionStart(startInput)), "startup used stale workspace access")
    invariant(await rejects(() => authority.authorizeRuntimeSessionStartStatus(startInput)), "startup status used stale workspace access")
  } finally {
    await harness.setWorkspaceAvailable(true)
  }
  await authority.authorizeRuntimeSessionStart(startInput)
  for (const invalid of [
    { ...startInput, ...member.runtime },
    { ...startInput, sessionId: "ses_unreserved" },
    { ...startInput, workspaceId: "workspace_unrelated" },
    { ...startInput, registrationOperationId: "op_unreserved" },
    { ...startInput, actorId: "actor_missing" },
  ]) {
    invariant(await rejects(() => authority.authorizeRuntimeSessionStart(invalid)), "startup accepted a mismatched reservation or actor")
    invariant(await rejects(() => authority.authorizeRuntimeSessionStartStatus(invalid)), "startup status accepted a mismatched reservation or actor")
  }
  invariant(await rejects(() => authority.authorizeRuntimeSession({ ...creator.runtime, workspaceId, sessionId, action: "read" })),
    "startup authorization exposed the unregistered session")
  invariant(asArray(await authority.listSessions(creator.auth, { workspaceId })).length === 0,
    "startup authorization published an unregistered session")

  const ambiguous = await authority.markSessionRegistrationAmbiguous({
    ...creator.runtime,
    operationId,
    sessionId,
    workspaceId,
    reason: "runtime outcome was not observed",
  })
  invariant(ambiguous.state === "reconciliation_required", "ambiguous registration did not require reconciliation")
  await authority.authorizeRuntimeSessionStart(startInput)
  await authority.registerRuntimeSession({
    ...creator.runtime,
    operationId,
    sessionId,
    workspaceId,
    title: "provider-neutral contract",
    ...RUNTIME_TIMES.registered,
  })
  invariant(
    asArray(await authority.listSessions(creator.auth, { workspaceId })).some(
      (row) => asRecord(row)?.session_id === sessionId,
    ),
    "exact registration retry did not reconcile the session",
  )
  const registered = await listedTimes(authority, creator.auth, workspaceId, sessionId)
  invariant(
    registered.updatedAt === RUNTIME_TIMES.registered.updatedAt,
    "registration listed the session at the authority's clock instead of the runtime's update time",
  )
  invariant(
    registered.createdAt === RUNTIME_TIMES.registered.createdAt,
    "registration listed the session at the authority's clock instead of the runtime's creation time",
  )

  await authority.authorizeRuntimeSessionStartStatus(startInput)
  invariant(await rejects(() => authority.authorizeRuntimeSessionStart(startInput)), "registered session retained startup authority")
  await authority.authorizeSessionRead(creator.auth, { sessionId, workspaceId })
  await authority.authorizeSessionWrite(creator.auth, { sessionId, workspaceId })
  await authority.authorizeRuntimeSession({
    ...creator.runtime,
    sessionId,
    workspaceId,
    action: "write",
  })

  invariant(
    await rejects(() => authority.authorizeSessionRead(member.auth, { sessionId, workspaceId })),
    "an organization or project role exposed a session on another person's workspace",
  )
  invariant(
    await rejects(() => authority.authorizeRuntimeSession({ ...member.runtime, sessionId, workspaceId, action: "read" })),
    "an organization or project role admitted the runtime to a session on another person's workspace",
  )
  invariant(
    await rejects(() => authority.reserveSession(member.auth, {
      operationId: "op_private_session_member", sessionId: "ses_private_session_member", workspaceId, kind: "create",
    })),
    "someone who does not own the workspace reserved a session in it",
  )
  let fencingToken: number | undefined
  if (harness.turnAuthority) {
    for (const turnId of ["message_canonical_actor", "message_forged_actor"]) {
      const lease = await harness.turnAuthority.acquireSessionTurn({
        ...creator.runtime,
        sessionId,
        workspaceId,
        turnId,
      })
      fencingToken = lease.fencingToken
      await harness.turnAuthority.releaseSessionTurn({
        ...creator.runtime,
        sessionId,
        workspaceId,
        turnId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      })
    }
  }
  await authority.syncSessionMessages(creator.auth, {
    sessionId,
    workspaceId,
    maxEventOrdinal: 1,
    updatedAt: RUNTIME_TIMES.synced,
    ...(fencingToken === undefined ? {} : { fencingToken }),
    messages: [
      {
        info: {
          id: "message_canonical_actor",
          role: "user",
          claxedo: {
            author: {
              id: creator.runtime.actorId,
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
          claxedo: { author: { id: member.runtime.actorId, kind: "human" } },
        },
        parts: [],
      },
    ],
  })
  const synced = await listedTimes(authority, creator.auth, workspaceId, sessionId)
  invariant(
    synced.updatedAt === RUNTIME_TIMES.synced,
    "a message sync listed the session at the authority's clock instead of the runtime's update time",
  )
  invariant(
    synced.createdAt === RUNTIME_TIMES.registered.createdAt,
    "a message sync moved the listed creation time",
  )
  await authority.upsertSessionVisibility(creator.auth, { workspaceId, sessions: [{ sessionId, title: "renamed" }] })
  invariant(
    (await listedTimes(authority, creator.auth, workspaceId, sessionId)).updatedAt === RUNTIME_TIMES.synced,
    "a visibility write with no runtime update time moved the listed update time",
  )
  const page = asRecord(await authority.readSessionMessages(creator.auth, { sessionId, workspaceId }))
  const messages = asArray(page?.messages)
  const canonical = messages.map(asRecord).find((message) => asRecord(message?.info)?.id === "message_canonical_actor")
  const forged = messages.map(asRecord).find((message) => asRecord(message?.info)?.id === "message_forged_actor")
  const canonicalAuthor = asRecord(asRecord(asRecord(canonical?.info)?.claxedo)?.author)
  const forgedAuthor = asRecord(asRecord(asRecord(forged?.info)?.claxedo)?.author)
  invariant(
    canonicalAuthor?.id === creator.runtime.actorId &&
      canonicalAuthor.kind === creator.runtime.actorKind &&
      canonicalAuthor.name === undefined,
    "canonical actor attribution trusted caller-supplied display metadata",
  )
  invariant(
    harness.turnAuthority
      ? forgedAuthor?.id === creator.runtime.actorId && forgedAuthor.kind === creator.runtime.actorKind
      : forgedAuthor === undefined,
    "message projection preserved a forged actor",
  )

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
  const compensatedStart = { ...creator.runtime, workspaceId, sessionId: compensatedSessionId, registrationOperationId: compensatedOperationId }
  await authority.authorizeRuntimeSessionStartStatus(compensatedStart)
  invariant(
    await refusesWith(() => authority.authorizeRuntimeSessionStart(compensatedStart), "workspace_authorization_denied"),
    "compensating session retained startup authority, or read as spent before its compensation completed",
  )
  invariant(
    await rejects(() =>
      authority.registerRuntimeSession({
        createdAt: Date.now(),
        updatedAt: Date.now(),
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
  await authority.authorizeRuntimeSessionStartStatus(compensatedStart)
  invariant(
    await refusesWith(() => authority.authorizeRuntimeSessionStart(compensatedStart), "session_reservation_spent"),
    "a compensated session's start was not refused as a spent reservation its creator can reserve again",
  )

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
  await authority.authorizeRuntimeSessionStart({ ...creator.runtime, workspaceId, sessionId: compensatedSessionId, registrationOperationId: releasedOperationId })

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
    access: { memberRefusedTheSession: true, memberRefusedCreation: true },
    attribution: { canonicalActorPreserved: true, forgedActorRemoved: true },
  }
}

export type RuntimeForkReservationConformanceReport = {
  forkReservedUnderAWritableParent: true
  registeredChildIsPrivateToItsCreator: true
  refusedUnderAnUnreadableParent: true
  refusedToAShareHolderAtEitherLevel: true
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
 *
 * Creating a session on a machine, a fork included, is the workspace owner's
 * alone: a share on the parent admits its holder to that session and to
 * nothing it would create.
 */
export async function exerciseRuntimeForkReservationConformance(
  harness: Pick<PrivateSessionAuthorityConformanceHarness, "authority" | "workspaceId" | "creator" | "member"> & {
    setParentShare(sessionId: string, level: "follow" | "send" | null): Promise<void>
  },
): Promise<RuntimeForkReservationConformanceReport> {
  const { authority, workspaceId, creator, member } = harness
  const parentSessionId = "ses_fork_reservation_parent"
  const sessionId = "ses_fork_reservation_child"

  await authority.reserveSession(creator.auth, {
    operationId: "op_fork_reservation_parent",
    sessionId: parentSessionId,
    workspaceId,
    kind: "create",
  })
  await authority.registerRuntimeSession({
    createdAt: Date.now(),
    updatedAt: Date.now(),
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
    "a fork under a writable parent was not reserved",
  )
  await authority.registerRuntimeSession({
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...creator.runtime,
    operationId: "op_fork_reservation_child",
    sessionId,
    workspaceId,
    title: "Reviewer",
  })
  await authority.authorizeRuntimeSession({ ...creator.runtime, sessionId, workspaceId, action: "write" })
  invariant(
    await rejects(() =>
      authority.authorizeRuntimeSession({ ...member.runtime, sessionId, workspaceId, action: "read" }),
    ),
    "a registered child was readable by an organization member who is not on it",
  )

  const memberFork = {
    operationId: "op_fork_member", sessionId: "ses_fork_member", workspaceId,
    kind: "fork" as const, parentSessionId,
  }
  invariant(await rejects(() => authority.reserveRuntimeSession(member.runtime, memberFork)),
    "someone who does not own the workspace forked a session in it")
  invariant(
    await rejects(() => authority.reserveRuntimeSession(member.runtime, {
      operationId: "op_fork_member_root", sessionId: "ses_fork_member_root", workspaceId, kind: "create",
    })),
    "someone who does not own the workspace reserved a root session in it",
  )
  for (const level of ["follow", "send"] as const) {
    await harness.setParentShare(parentSessionId, level)
    await authority.authorizeRuntimeSession({ ...member.runtime, sessionId: parentSessionId, workspaceId, action: "read" })
    invariant(await rejects(() => authority.reserveRuntimeSession(member.runtime, memberFork)),
      `a ${level} share on the parent admitted its holder to fork it`)
  }
  await harness.setParentShare(parentSessionId, null)

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
    forkReservedUnderAWritableParent: true,
    registeredChildIsPrivateToItsCreator: true,
    refusedUnderAnUnreadableParent: true,
    refusedToAShareHolderAtEitherLevel: true,
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
  /** A member of the workspace's organization who does not own the workspace or the machine. */
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
  refusedWhileAReservationHoldsIt: true
}

/**
 * The adoption contract both adapters answer: a session the host already held
 * becomes the enrollment owner's, once, and nobody else's.
 *
 * Every adopted session id stands for a transcript created on the machine
 * before remote access existed, so none of them is reserved first — which is
 * the whole point, and why no other action in the port can reach this state.
 * The one id reserved below is the case where that is not so.
 */
export async function exercisePrivateSessionAdoptionConformance(
  harness: PrivateSessionAdoptionConformanceHarness,
): Promise<PrivateSessionAdoptionConformanceReport> {
  const { authority, workspaceId, hostId, owner, member } = harness
  const sessionId = "ses_local_before_remote_access"
  const adopt = (
    who: PrivateSessionAdoptionConformanceHarness["owner"],
    id: string,
  ) => authority.adoptRuntimeSession({ ...who.runtime, sessionId: id, workspaceId, hostId, ...RUNTIME_TIMES.adopted })

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
  const adoptedTimes = await listedTimes(authority, owner.auth, workspaceId, sessionId)
  invariant(
    adoptedTimes.updatedAt === RUNTIME_TIMES.adopted.updatedAt,
    "adoption listed the session at the authority's clock instead of the runtime's update time",
  )
  invariant(
    adoptedTimes.createdAt === RUNTIME_TIMES.adopted.createdAt,
    "adoption listed the session at the authority's clock instead of the runtime's creation time",
  )
  invariant(
    await rejects(() =>
      authority.authorizeRuntimeSession({ ...member.runtime, sessionId, workspaceId, action: "read" }),
    ),
    "adoption made a private session visible to an organization member",
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
    "an organization member who does not own the machine adopted a session",
  )

  const held = "ses_reserved_before_adoption"
  await authority.reserveSession(owner.auth, {
    operationId: "op_reserved_before_adoption",
    sessionId: held,
    workspaceId,
    kind: "create",
  })
  invariant(
    await rejects(() => adopt(owner, held)),
    "adoption claimed a session a live reservation already holds",
  )

  return {
    refusedBeforeAssignment: true,
    adoptedForEnrollmentOwner: true,
    idempotent: true,
    refusedForMember: true,
    refusedWhileAReservationHoldsIt: true,
  }
}

export type SessionWriteClassConformanceHarness = {
  authority: Pick<PrivateSessionAuthority, "authorizeRuntimeSession">
  /** The share-grant surface, which lives on the workspace authority in both adapters. */
  shares: Pick<WorkspaceAuthority, "grantSessionShare">
  workspaceId: string
  /** A session the workspace's owner registered, so only the share admits the grantee. */
  sessionId: string
  creator: {
    auth: SignedControlPlaneAuth
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  }
  /** A member of the session's organization who does not own the workspace. */
  grantee: {
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
    /** How this adapter's grant route names the grantee. */
    target: { grantedToTokenIdentifier: string } | { grantedToUserId: string }
  }
}

export type SessionWriteClassConformanceReport = {
  sendGranteeDrivesTheTurn: true
  sendGranteeRefusedSessionControl: true
  creatorHoldsBothClasses: true
  absentClassAsksAboutTheTurn: true
}

/**
 * What a `send` share buys, on whichever store answers the runtime.
 *
 * A share carries the agent's turn — prompting it, answering what it asks,
 * stopping it — and nothing else. Shell, permission mode, deletion, forks and
 * the rest arrive as the same `write` action and are the workspace owner's,
 * so the runtime names the class and the store has to distinguish the two. The operations behind each class are the runtime's
 * route table, pinned there rather than here.
 */
export async function exerciseSessionWriteClassConformance(
  harness: SessionWriteClassConformanceHarness,
): Promise<SessionWriteClassConformanceReport> {
  const { authority, shares, workspaceId, sessionId, creator, grantee } = harness
  // Bound rather than called through `shares`: one adapter is a class whose
  // methods read `this`, and the port declares the grant optional.
  const grantShare = shares.grantSessionShare?.bind(shares)
  invariant(grantShare, "the adapter under test does not implement session shares")
  const write = (
    who: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>,
    writeClass?: "agent_turn" | "session_control",
  ) =>
    authority.authorizeRuntimeSession({
      ...who,
      sessionId,
      workspaceId,
      action: "write",
      ...(writeClass ? { writeClass } : {}),
    })

  await grantShare(creator.auth, { sessionId, workspaceId, level: "send", ...grantee.target })

  await write(grantee.runtime, "agent_turn")
  invariant(
    await rejects(() => write(grantee.runtime, "session_control")),
    "a send grantee was admitted a write the share does not carry",
  )
  await write(grantee.runtime)

  await write(creator.runtime, "agent_turn")
  await write(creator.runtime, "session_control")

  return {
    sendGranteeDrivesTheTurn: true,
    sendGranteeRefusedSessionControl: true,
    creatorHoldsBothClasses: true,
    absentClassAsksAboutTheTurn: true,
  }
}
