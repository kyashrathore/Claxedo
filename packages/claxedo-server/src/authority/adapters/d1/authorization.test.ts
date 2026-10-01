import { inviteOrgMember } from "../../../test-support/invite-org-member"
import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import type { D1CoreAuthorityBoundary } from "./core-authority"
import { composeBetterAuthD1Authority } from "../worker/better-auth-d1-compose"
import { may } from "./authorization"
import {
  controlPlaneMigrations,
  miniflareControlPlaneDatabase,
  type ControlPlaneDatabase,
} from "../../../test-support/control-plane-migrations"

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((database) => database.dispose()))
})

async function signed(authority: D1CoreAuthorityBoundary, subject: string): Promise<SignedControlPlaneAuth> {
  const identity: AuthIdentity = { adapter: "better-auth", issuer: "https://auth.example.test", subject }
  const mapped = await authority.ensureApplicationIdentity(identity)
  if (mapped.state !== "active") throw new Error(`identity did not become active: ${mapped.state}`)
  const principal: ControlPlanePrincipal = {
    userId: mapped.userId,
    actorId: mapped.actorId,
    actorKind: "human",
    deploymentId: "deployment-a",
    sessionId: `session:${subject}`,
    authenticatedAt: 1_800_000_000_000,
    methods: ["oauth:github"],
    assurance: "single-factor",
    client: {
      kind: "browser",
      tokenKind: "browser-session",
      id: "browser",
      resource: "https://api.example.test",
      scopes: ["openid"],
      origin: "https://app.example.test",
    },
    identity,
  }
  return {
    mode: "signed",
    principal,
    user: { subject: mapped.userId, tokenIdentifier: `${identity.issuer}|${subject}`, issuer: identity.issuer },
  }
}

const id = (auth: SignedControlPlaneAuth) => auth.principal!.userId
const runtime = (auth: SignedControlPlaneAuth) =>
  ({ principalKind: "user" as const, actorId: auth.principal!.actorId, actorKind: "human" as const })

/**
 * Alice owns `ws_alice` in Acme and holds `ses_alice` there. Everyone else is
 * in Acme with some other standing on the project or the organization, and
 * none of it is a share.
 */
async function setup() {
  const controlPlane = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  active.push(controlPlane)
  const { database } = controlPlane
  const authority = composeBetterAuthD1Authority({
    env: {
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted",
      CLAXEDO_DEPLOYMENT_ID: "deployment-a",
      CONTROL_PLANE_DB: database,
    },
    product: { kind: "claxedo-hosted" },
  })
  const alice = await signed(authority, "alice")
  const orgAdmin = await signed(authority, "org-admin")
  const projectOwnerRow = await signed(authority, "project-owner-row")
  const teamEditor = await signed(authority, "team-editor")
  const memberGrant = await signed(authority, "member-grant")
  const follower = await signed(authority, "follower")
  const sender = await signed(authority, "sender")
  await authority.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
  for (const [who, role] of [
    [orgAdmin, "admin"], [projectOwnerRow, "member"], [teamEditor, "member"], [memberGrant, "member"],
    [follower, "member"], [sender, "member"],
  ] as const) {
    await inviteOrgMember(database, alice, { orgId: "org_acme", userPublicId: id(who), role })
  }
  const created = await authority.createWorkspace(alice, {
    workspaceId: "ws_alice",
    orgId: "org_acme",
    displayName: "alice",
    backing: "local-worktree",
    repoUrl: "https://github.com/acme/app",
  })
  const projectId = created.project_id
  await authority.grantProjectMember!(alice, { projectId, userPublicId: id(memberGrant), role: "admin" })
  const team = (await authority.createTeamInOrg!(alice, { orgId: "org_acme", name: "Eng" })) as { team_id: string }
  await authority.addTeamMember!(alice, { teamId: team.team_id, userPublicId: id(teamEditor) })
  await authority.grantTeamProject!(alice, { teamId: team.team_id, projectId, role: "editor" })
  // No route writes an `owner` row for anyone but the project's creator; the
  // row is written directly to prove that holding one reaches no workspace.
  await database.prepare(`
    insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at)
    values (?, ?, 'owner', 1, 1, null)
  `).bind(projectId, id(projectOwnerRow)).run()
  await registered(authority, alice, "ses_alice")
  await registered(authority, alice, "ses_alice_other")
  return {
    authority, database, alice, projectId, teamId: team.team_id,
    grantees: { orgAdmin, projectOwnerRow, teamEditor, memberGrant },
    follower, sender,
  }
}

async function registered(authority: D1CoreAuthorityBoundary, who: SignedControlPlaneAuth, sessionId: string) {
  await authority.reserveSession(who, { operationId: `op_${sessionId}`, sessionId, workspaceId: "ws_alice", kind: "create" })
  await authority.registerRuntimeSession({
    ...runtime(who), operationId: `op_${sessionId}`, sessionId, workspaceId: "ws_alice", createdAt: 1, updatedAt: 1,
  })
}

/** Every door a workspace, its machine or its sessions has, knocked on by someone who is not its owner. */
async function expectShutOut(authority: D1CoreAuthorityBoundary, who: SignedControlPlaneAuth, label: string) {
  const workspaceId = "ws_alice"
  const refused = { status: 403 }
  await expect(authority.openWorkspace(who, { workspaceId }), `${label} opened the workspace`).rejects.toMatchObject(refused)
  expect((await authority.listWorkspaces(who) as Array<{ workspace_id: string }>).map((row) => row.workspace_id),
    `${label} listed the workspace`).not.toContain(workspaceId)
  await expect(authority.activeWorkspaceHost!(who, { workspaceId }), `${label} read the machine serving it`)
    .rejects.toMatchObject(refused)
  await expect(authority.unassignWorkspaceHost!(who, { workspaceId }), `${label} unassigned its machine`)
    .rejects.toMatchObject(refused)
  for (const role of ["viewer", "owner"] as const) {
    await expect(authority.recordRuntimeAccessToken(who, {
      jti: `jti_${id(who)}_${role}`, workspaceId, hostId: "host_alice", ...runtime(who), role, expiresAt: 1_900_000_000_000,
    }), `${label} was minted a ${role} runtime token`).rejects.toMatchObject(refused)
  }
  await expect(authority.resolveRuntimeMachineAccess(who.principal!.actorId, workspaceId), `${label} acted on the machine`)
    .rejects.toMatchObject(refused)
  await expect(authority.reserveSession(who, {
    operationId: `op_create_${id(who)}`, sessionId: `ses_create_${id(who)}`, workspaceId, kind: "create",
  }), `${label} created a session`).rejects.toMatchObject(refused)
  await expect(authority.reserveRuntimeSession(runtime(who), {
    operationId: `op_fork_${id(who)}`, sessionId: `ses_fork_${id(who)}`, workspaceId, kind: "fork", parentSessionId: "ses_alice",
  }), `${label} forked a session`).rejects.toMatchObject(refused)
  await expect(authority.authorizeRuntimeSession({ ...runtime(who), sessionId: "ses_alice_other", workspaceId, action: "read" }),
    `${label} read a session nobody shared with them`).rejects.toMatchObject(refused)
  expect((await authority.listSessions(who, { workspaceId })).map((row) => row.session_id),
    `${label} listed a session nobody shared with them`).not.toContain("ses_alice_other")
}

describe("one authorization owner", () => {
  test("no organization role, project owner row, team grant or member grant reaches another person's workspace, machine or sessions", async () => {
    const { authority, alice, projectId, teamId, grantees } = await setup()

    for (const [label, who] of Object.entries(grantees)) {
      await expectShutOut(authority, who, label)
      await expect(authority.authorizeRuntimeSession({ ...runtime(who), sessionId: "ses_alice", workspaceId: "ws_alice", action: "read" }),
        `${label} read the owner's session`).rejects.toMatchObject({ status: 403 })
      await expect(authority.grantSessionParticipant(alice, {
        sessionId: "ses_alice", workspaceId: "ws_alice", participantActorId: who.principal!.actorId,
      }), `${label} was added as a participant`).rejects.toMatchObject({ status: 403 })
    }

    const listing = (await authority.listProjectAccess!(alice, { projectId })).entries
    expect(listing).toEqual(expect.arrayContaining([
      { kind: "user", user_id: id(alice), role: "owner", source: "owner" },
      { kind: "user", user_id: id(grantees.memberGrant), role: "admin", source: "member" },
      { kind: "team", team_id: teamId, name: "Eng", role: "editor", source: `team:${teamId}` },
      { kind: "user", user_id: id(grantees.orgAdmin), role: "admin", source: "org-role" },
    ]))
    expect(await authority.projectRole(grantees.memberGrant, { projectId: projectId as never })).toMatchObject({ role: "admin" })
    expect(await authority.projectRole(grantees.teamEditor, { projectId: projectId as never })).toMatchObject({ role: "editor" })
    expect(await authority.projectRole(grantees.projectOwnerRow, { projectId: projectId as never })).toMatchObject({ role: "owner" })
  })

  test("the owner holds every workspace, machine and session action", async () => {
    const { authority, alice } = await setup()
    const workspaceId = "ws_alice"
    expect(await authority.openWorkspace(alice, { workspaceId })).toMatchObject({ allowed: true, role: "owner" })
    expect((await authority.listWorkspaces(alice) as Array<{ workspace_id: string; role: string }>))
      .toEqual([expect.objectContaining({ workspace_id: workspaceId, role: "owner" })])
    expect(await authority.activeWorkspaceHost!(alice, { workspaceId })).toEqual({ active: false })
    await authority.recordRuntimeAccessToken(alice, {
      jti: "jti_alice", workspaceId, hostId: "host_alice", ...runtime(alice), role: "owner", expiresAt: 1_900_000_000_000,
    })
    expect(await authority.runtimeAccessTokenActive({ jti: "jti_alice", workspaceId, hostId: "host_alice" }))
      .toEqual({ active: true })
    expect(await authority.resolveRuntimeMachineAccess(alice.principal!.actorId, workspaceId)).toMatchObject({ role: "owner" })
    await authority.reserveRuntimeSession(runtime(alice), {
      operationId: "op_fork_alice", sessionId: "ses_fork_alice", workspaceId, kind: "fork", parentSessionId: "ses_alice",
    })
    for (const writeClass of ["agent_turn", "session_control"] as const) {
      await authority.authorizeRuntimeSession({ ...runtime(alice), sessionId: "ses_alice", workspaceId, action: "write", writeClass })
    }
    expect((await authority.listSessions(alice, { workspaceId })).map((row) => row.session_id).sort())
      .toEqual(["ses_alice", "ses_alice_other"])
  })

  test("a share holds exactly its level's actions on exactly its session, and nothing of the workspace", async () => {
    const { authority, alice, follower, sender } = await setup()
    const workspaceId = "ws_alice"
    const write = (who: SignedControlPlaneAuth, writeClass: "agent_turn" | "session_control") =>
      authority.authorizeRuntimeSession({ ...runtime(who), sessionId: "ses_alice", workspaceId, action: "write", writeClass })
    await authority.grantSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToUserId: id(follower), level: "follow" })
    await authority.grantSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToUserId: id(sender), level: "send" })

    await authority.authorizeRuntimeSession({ ...runtime(follower), sessionId: "ses_alice", workspaceId, action: "read" })
    await expect(write(follower, "agent_turn")).rejects.toMatchObject({ status: 403 })
    await write(sender, "agent_turn")
    await expect(write(sender, "session_control")).rejects.toMatchObject({ status: 403 })
    for (const [label, who] of [["follow share holder", follower], ["send share holder", sender]] as const) {
      await expectShutOut(authority, who, label)
      expect((await authority.listSessions(who, { workspaceId })).map((row) => row.session_id)).toEqual(["ses_alice"])
      await expect(authority.listSessionShares!(who, { sessionId: "ses_alice", workspaceId }))
        .resolves.toMatchObject({ can_manage_shares: false })
    }

    await authority.revokeSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToUserId: id(sender) })
    await expect(authority.authorizeRuntimeSession({ ...runtime(sender), sessionId: "ses_alice", workspaceId, action: "read" }))
      .rejects.toMatchObject({ status: 403 })
  })

  test("a share holder's runtime token reaches their session alone, and revoking the share revokes it and nothing of the owner's", async () => {
    const { authority, alice, sender } = await setup()
    const workspaceId = "ws_alice"
    const token = (who: SignedControlPlaneAuth, jti: string, extra: { role?: "viewer" | "owner"; sessionId?: string } = {}) =>
      authority.recordRuntimeAccessToken(who, {
        jti, workspaceId, hostId: "host_alice", ...runtime(who), role: extra.role ?? "viewer", expiresAt: 1_900_000_000_000,
        ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
      })
    const active = async (jti: string) => await authority.runtimeAccessTokenActive({ jti, workspaceId, hostId: "host_alice" })

    await expect(token(sender, "jti_before_share", { sessionId: "ses_alice" })).rejects.toMatchObject({ status: 403 })
    await authority.grantSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToUserId: id(sender), level: "send" })
    await authority.grantSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToOrgId: "org_acme" })
    await token(sender, "jti_share", { sessionId: "ses_alice" })
    expect(await active("jti_share")).toEqual({ active: true })
    await expect(token(sender, "jti_other_session", { sessionId: "ses_alice_other" })).rejects.toMatchObject({ status: 403 })
    await expect(token(sender, "jti_workspace")).rejects.toMatchObject({ status: 403 })
    await expect(token(sender, "jti_share_owner", { sessionId: "ses_alice", role: "owner" })).rejects.toMatchObject({ status: 403 })
    await token(alice, "jti_owner", { role: "owner" })

    // The token is recorded under the share naming the sender, so ending the
    // organization's share leaves it, and ending theirs revokes it.
    await authority.revokeSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToOrgId: "org_acme" })
    expect(await active("jti_share")).toEqual({ active: true })
    expect(await active("jti_owner")).toEqual({ active: true })
    await token(sender, "jti_share_again", { sessionId: "ses_alice" })
    expect(await authority.revokeSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToUserId: id(sender) }))
      .toMatchObject({ revoked: true, runtime_tokens_revoked: 2 })
    expect(await active("jti_share")).toMatchObject({ active: false, code: "runtime_access_token_revoked" })
    expect(await active("jti_share_again")).toMatchObject({ active: false, code: "runtime_access_token_revoked" })
    await expect(token(sender, "jti_after_revoke", { sessionId: "ses_alice" })).rejects.toMatchObject({ status: 403 })
    expect(await active("jti_owner")).toEqual({ active: true })
  })

  test("a runtime token a team share admitted ends with its holder's team membership and never comes back", async () => {
    const { authority, alice, teamId, grantees: { teamEditor } } = await setup()
    const workspaceId = "ws_alice"
    await authority.grantSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToTeamId: teamId })
    await authority.recordRuntimeAccessToken(teamEditor, {
      jti: "jti_team", workspaceId, hostId: "host_alice", ...runtime(teamEditor), role: "viewer", sessionId: "ses_alice",
      expiresAt: 1_900_000_000_000,
    })
    await authority.recordRuntimeAccessToken(alice, {
      jti: "jti_owner", workspaceId, hostId: "host_alice", ...runtime(alice), role: "owner", expiresAt: 1_900_000_000_000,
    })
    const active = (jti: string) => authority.runtimeAccessTokenActive({ jti, workspaceId, hostId: "host_alice" })
    expect(await active("jti_team")).toEqual({ active: true })

    await authority.removeTeamMember!(alice, { teamId, userPublicId: id(teamEditor) })
    await authority.grantSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToUserId: id(teamEditor) })
    await authority.authorizeRuntimeSession({ ...runtime(teamEditor), sessionId: "ses_alice", workspaceId, action: "read" })
    expect(await active("jti_team")).toMatchObject({ active: false, code: "runtime_access_token_revoked" })
    expect(await active("jti_owner")).toEqual({ active: true })
  })

  test("revoking a share revokes exactly the runtime tokens it admitted, whoever is on its team by then", async () => {
    const { authority, database, alice, teamId, grantees: { teamEditor }, sender } = await setup()
    const workspaceId = "ws_alice"
    const token = (who: SignedControlPlaneAuth, jti: string) => authority.recordRuntimeAccessToken(who, {
      jti, workspaceId, hostId: "host_alice", ...runtime(who), role: "viewer", sessionId: "ses_alice", expiresAt: 1_900_000_000_000,
    })
    const revokedAt = async (jti: string) =>
      (await database.prepare(`select revoked_at from runtime_access_tokens where jti = ?`).bind(jti).first<{ revoked_at: number | null }>())?.revoked_at
    await authority.addTeamMember!(alice, { teamId, userPublicId: id(sender) })
    await authority.grantSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToUserId: id(sender) })
    await authority.grantSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToTeamId: teamId })
    await token(sender, "jti_direct")
    await token(teamEditor, "jti_team")
    // The holder is off the team by a path that stamps nothing, so only the
    // token's own record can say which share admitted it.
    await database.prepare(`update team_memberships set revoked_at = 1 where team_id = ? and user_id = ?`)
      .bind(teamId, id(teamEditor)).run()

    expect(await authority.revokeSessionShare!(alice, { sessionId: "ses_alice", workspaceId, grantedToTeamId: teamId }))
      .toMatchObject({ revoked: true, runtime_tokens_revoked: 1 })
    expect(await revokedAt("jti_team")).toEqual(expect.any(Number))
    expect(await revokedAt("jti_direct")).toBeNull()
    expect(await authority.runtimeAccessTokenActive({ jti: "jti_direct", workspaceId, hostId: "host_alice" })).toEqual({ active: true })
  })

  test("a share lives on its owner's standing: suspending the owner stops it, and removing them revokes it and its tokens", async () => {
    const { authority, database, alice, grantees: { orgAdmin: owner }, sender } = await setup()
    const workspaceId = "ws_admin"
    await authority.createWorkspace(owner, {
      workspaceId, orgId: "org_acme", displayName: "admin", backing: "local-worktree", repoUrl: "https://github.com/acme/admin",
    })
    await authority.reserveSession(owner, { operationId: "op_ses_admin", sessionId: "ses_admin", workspaceId, kind: "create" })
    await authority.registerRuntimeSession({
      ...runtime(owner), operationId: "op_ses_admin", sessionId: "ses_admin", workspaceId, createdAt: 1, updatedAt: 1,
    })
    await authority.grantSessionShare!(owner, { sessionId: "ses_admin", workspaceId, grantedToUserId: id(sender), level: "send" })
    await authority.recordRuntimeAccessToken(sender, {
      jti: "jti_shared", workspaceId, hostId: "host_admin", ...runtime(sender), role: "viewer", sessionId: "ses_admin", expiresAt: 1_900_000_000_000,
    })
    const reads = () => authority.authorizeRuntimeSession({ ...runtime(sender), sessionId: "ses_admin", workspaceId, action: "read" })
    const active = () => authority.runtimeAccessTokenActive({ jti: "jti_shared", workspaceId, hostId: "host_admin" })
    const suspended = (state: "active" | "suspended") => database
      .prepare(`update users set state = ?, suspended_at = ? where user_id = ?`)
      .bind(state, state === "suspended" ? 1 : null, id(owner)).run()

    await reads()
    await suspended("suspended")
    await expect(reads()).rejects.toMatchObject({ status: 403 })
    expect(await active()).toMatchObject({ active: false })
    await suspended("active")
    await reads()

    expect(await authority.removeOrgMember!(alice, { orgId: "org_acme", userPublicId: id(owner) }))
      .toMatchObject({ removed: true, session_shares_revoked: 1, runtime_tokens_revoked: 1 })
    await expect(reads()).rejects.toMatchObject({ status: 403 })
    expect(await active()).toMatchObject({ active: false, code: "runtime_access_token_revoked" })
    expect(await database.prepare(`select count(*) as live from session_share_grants where session_id = 'ses_admin' and revoked_at is null`)
      .first()).toEqual({ live: 0 })
  })

  test("organization and project actions follow the organization and project roles", async () => {
    const { database, alice, projectId, grantees } = await setup()
    const principal = (who: SignedControlPlaneAuth) => ({ userId: id(who), actorId: who.principal!.actorId })
    const org = { kind: "org" as const, orgId: "org_acme" }
    const project = { kind: "project" as const, projectId }

    expect(await may(database, principal(alice), "own", org)).toBe(true)
    expect(await may(database, principal(grantees.orgAdmin), "administer", org)).toBe(true)
    expect(await may(database, principal(grantees.orgAdmin), "own", org)).toBe(false)
    expect(await may(database, principal(grantees.teamEditor), "administer", org)).toBe(false)
    expect(await may(database, principal(grantees.teamEditor), "member", org)).toBe(true)

    expect(await may(database, principal(grantees.memberGrant), "admin", project)).toBe(true)
    expect(await may(database, principal(grantees.teamEditor), "write", project)).toBe(true)
    expect(await may(database, principal(grantees.teamEditor), "admin", project)).toBe(false)
    expect(await may(database, principal(grantees.orgAdmin), "admin", project)).toBe(true)

    await database.prepare("update org_memberships set revoked_at = 99 where user_id = ?").bind(id(grantees.memberGrant)).run()
    expect(await may(database, principal(grantees.memberGrant), "read", project)).toBe(false)
    expect(await may(database, principal(grantees.memberGrant), "member", org)).toBe(false)
  })
})
