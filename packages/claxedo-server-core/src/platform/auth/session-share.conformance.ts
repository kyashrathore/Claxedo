import { asArray, asRecord } from "@claxedo/helpers/guards"
import type { SignedControlPlaneAuth } from "./auth"
import type { WorkspaceAuthority } from "./authority"
import type { PrivateSessionAuthority, PrivateSessionRuntimePrincipal } from "./private-session-authority"
import { invariant, refusesWith, rejects } from "./private-session-conformance-checks"
import { storedSessionShareLevel } from "./session-share-level"

export type SessionShareLevelConformanceHarness = {
  authority: Pick<PrivateSessionAuthority, "authorizeRuntimeSession" | "listSessions">
  /** The share-grant surface, which lives on the workspace authority in both adapters. */
  shares: Pick<WorkspaceAuthority, "grantSessionShare" | "revokeSessionShare" | "listSessionShares">
  workspaceId: string
  /** A session the workspace's owner registered, so only the share decides the grantee's access. */
  sessionId: string
  /** A second session the owner registered in the same workspace and shared with nobody. */
  otherSessionId: string
  creator: { auth: SignedControlPlaneAuth }
  /**
   * A member of the session's organization who does not own the workspace,
   * so the share is the only thing that can admit them and a write proves the
   * level alone carries it.
   */
  grantee: {
    auth: SignedControlPlaneAuth
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
    /** How this adapter's grant route names the grantee. */
    target: { grantedToTokenIdentifier: string } | { grantedToUserId: string }
  }
  /** An owner or admin of the organization who was never given a grant. */
  organizationAdministrator: {
    auth: SignedControlPlaneAuth
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
  }
  /** Someone outside the organization, so no share may be offered to them. */
  outsider: { target: { grantedToTokenIdentifier: string } | { grantedToUserId: string } }
}

export type SessionShareLevelConformanceReport = {
  defaultsToFollow: true
  followReadsButDoesNotWrite: true
  sendWritesWithoutWorkspaceRank: true
  downgradeEndsWriting: true
  revokeEndsReading: true
  shareReachesNoOtherSession: true
  organizationAdministratorRefusedWithoutAGrant: true
  offerRefusedOutsideTheOrganization: true
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
  const { authority, shares, workspaceId, sessionId, otherSessionId, creator, grantee, organizationAdministrator, outsider } = harness
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
  invariant(
    asArray(await authority.listSessions(grantee.auth, { workspaceId })).map((row) => asRecord(row)?.session_id).join() === sessionId,
    "a share holder listed a session other than the one shared with them",
  )
  for (const action of ["read", "write"] as const) {
    invariant(
      await rejects(() => authority.authorizeRuntimeSession({ ...grantee.runtime, sessionId: otherSessionId, workspaceId, action })),
      `a share admitted its holder to ${action} another session in the workspace`,
    )
  }

  const lowered = await grant("follow")
  invariant(
    lowered.grant_id === first.grant_id && lowered.level === "follow",
    "lowering a live grant to follow made a second grant",
  )
  await runtime("read")
  invariant(await rejects(() => runtime("write")), "a downgraded grantee kept writing")

  await revokeShare(creator.auth, { sessionId, workspaceId, ...grantee.target })
  invariant(await rejects(() => runtime("read")), "a revoked grantee kept reading")

  const asAdministrator = (action: "read" | "write") =>
    authority.authorizeRuntimeSession({ ...organizationAdministrator.runtime, sessionId, workspaceId, action })
  invariant(await rejects(() => asAdministrator("read")), "an organization administrator read a session nobody shared with them")
  invariant(await rejects(() => asAdministrator("write")), "an organization administrator wrote a session nobody shared with them")
  invariant(
    asArray(await authority.listSessions(organizationAdministrator.auth, { workspaceId })).every(
      (row) => asRecord(row)?.session_id !== sessionId,
    ),
    "an organization administrator listed a session nobody shared with them",
  )

  invariant(
    await refusesWith(
      () => grantShare(creator.auth, { sessionId, workspaceId, ...outsider.target }),
      "session_share_target_outside_organization",
    ),
    "a share was offered to someone outside the organization",
  )

  return {
    defaultsToFollow: true,
    followReadsButDoesNotWrite: true,
    sendWritesWithoutWorkspaceRank: true,
    downgradeEndsWriting: true,
    revokeEndsReading: true,
    shareReachesNoOtherSession: true,
    organizationAdministratorRefusedWithoutAGrant: true,
    offerRefusedOutsideTheOrganization: true,
  }
}

export type SessionShareRuntimeTokenConformanceHarness = {
  sessions: Pick<PrivateSessionAuthority, "authorizeRuntimeSession">
  workspace: Pick<
    WorkspaceAuthority,
    "openWorkspace" | "recordRuntimeAccessToken" | "runtimeAccessTokenActive" | "grantSessionShare"
  >
  workspaceId: string
  hostId: string
  /** A session the workspace's owner registered, so only the share can admit the grantee. */
  sessionId: string
  owner: {
    auth: SignedControlPlaneAuth
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
    /** Removes the owner from the workspace's organization; the last step of the suite. */
    leaveOrganization: () => Promise<void>
  }
  /** A member of the session's organization who does not own the workspace. */
  grantee: {
    auth: SignedControlPlaneAuth
    runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
    /** How this adapter's grant route names the grantee. */
    target: { grantedToTokenIdentifier: string } | { grantedToUserId: string }
  }
  /** A future timestamp on this adapter's clock. */
  expiresAt: number
}

export type SessionShareRuntimeTokenConformanceReport = {
  workspaceRefusedToAShareHolder: true
  workspaceTokenRefusedToAShareHolder: true
  sendShareDrivesTheTurn: true
  downgradeEndsTheTurn: true
  ownerHoldsTheWorkspaceToken: true
  offboardedOwnerLosesSessionWorkspaceAndToken: true
}

/**
 * A session share reaches the session and never the workspace.
 *
 * A Runtime Access Token that names only a workspace reaches everything the
 * machine serves for it, so it is the workspace owner's alone: a share holder
 * at either level is refused the workspace and such a token, while the
 * session authority still answers what their level carries. Leaving the
 * organization ends the owner's session, workspace and token together.
 */
export async function exerciseSessionShareRuntimeTokenConformance(
  harness: SessionShareRuntimeTokenConformanceHarness,
): Promise<SessionShareRuntimeTokenConformanceReport> {
  const { sessions, workspace, workspaceId, hostId, sessionId, owner, grantee, expiresAt } = harness
  // Bound rather than called through the object: one adapter is a class whose
  // methods read `this`, and the port declares `grantSessionShare` optional.
  const openWorkspace = workspace.openWorkspace.bind(workspace)
  const recordToken = workspace.recordRuntimeAccessToken.bind(workspace)
  const tokenActive = workspace.runtimeAccessTokenActive.bind(workspace)
  const grantShare = workspace.grantSessionShare?.bind(workspace)
  invariant(grantShare, "the adapter under test does not implement session shares")

  const mint = (
    who: { auth: SignedControlPlaneAuth; runtime: { actorId: string; actorKind: "human" } },
    jti: string,
    role: "viewer" | "owner",
  ) => recordToken(who.auth, {
    jti,
    workspaceId,
    hostId,
    actorId: who.runtime.actorId,
    actorKind: who.runtime.actorKind,
    role,
    expiresAt,
  })
  const active = async (jti: string) => asRecord(await tokenActive({ jti, workspaceId, hostId }))?.active === true
  const as = (who: typeof owner | typeof grantee, action: "read" | "write") =>
    sessions.authorizeRuntimeSession({ ...who.runtime, sessionId, workspaceId, action })
  const share = (level: "follow" | "send") =>
    grantShare(owner.auth, { sessionId, workspaceId, level, ...grantee.target })

  for (const level of [undefined, "send", "follow"] as const) {
    if (level) await share(level)
    invariant(
      await rejects(() => openWorkspace(grantee.auth, { workspaceId })),
      `the workspace opened for ${level ? `a ${level} share holder` : "someone holding no share"}`,
    )
    for (const role of ["viewer", "owner"] as const) {
      invariant(
        await rejects(() => mint(grantee, `rat_conformance_${level ?? "unshared"}_${role}`, role)),
        `a workspace runtime token was minted for ${level ? `a ${level} share holder` : "someone holding no share"}`,
      )
    }
    if (level === "send") await as(grantee, "write")
    if (level === "follow") {
      await as(grantee, "read")
      invariant(await rejects(() => as(grantee, "write")), "a downgraded share holder kept driving the turn")
    }
  }

  const opened = asRecord(await openWorkspace(owner.auth, { workspaceId }))
  invariant(opened?.allowed === true && opened.role === "owner", "the workspace did not open for its owner")
  await mint(owner, "rat_conformance_owner", "owner")
  invariant(await active("rat_conformance_owner"), "the owner's runtime token was not active once minted")

  await owner.leaveOrganization()
  invariant(await rejects(() => as(owner, "read")), "an offboarded owner kept reading their session")
  invariant(await rejects(() => as(owner, "write")), "an offboarded owner kept writing their session")
  invariant(await rejects(() => openWorkspace(owner.auth, { workspaceId })), "an offboarded owner kept opening the workspace")
  invariant(!await active("rat_conformance_owner"), "an offboarded owner's runtime token stayed active")
  invariant(
    await rejects(() => mint(owner, "rat_conformance_owner_again", "owner")),
    "an offboarded owner was minted a new runtime token",
  )

  return {
    workspaceRefusedToAShareHolder: true,
    workspaceTokenRefusedToAShareHolder: true,
    sendShareDrivesTheTurn: true,
    downgradeEndsTheTurn: true,
    ownerHoldsTheWorkspaceToken: true,
    offboardedOwnerLosesSessionWorkspaceAndToken: true,
  }
}
