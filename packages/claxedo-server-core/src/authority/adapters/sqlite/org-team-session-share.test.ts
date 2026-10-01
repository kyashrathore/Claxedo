import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { asProjectId } from "@claxedo/server-core/platform/auth/branded-id"
import { createSqliteWorkspaceAuthority } from "./workspace-authority"
import { closeAuthorityDatabases, openAuthorityDb, type SqliteAuthorityDb } from "./workspace-authority-store"

const roots: string[] = []

function signedAuth(subject: string): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: `tok_${subject}`,
    user: {
      subject,
      tokenIdentifier: `https://idp.example.test|${subject}`,
      issuer: "https://idp.example.test",
    },
  }
}

const alice = signedAuth("alice")
const bob = signedAuth("bob")

afterEach(() => {
  closeAuthorityDatabases()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-org-team-share-"))
  roots.push(root)
  const file = path.join(root, "authority.sqlite")
  return {
    authority: createSqliteWorkspaceAuthority({ path: file }),
    db: openAuthorityDb({ path: file }),
  }
}

function addOrgMember(db: () => SqliteAuthorityDb, orgId: string, tokenIdentifier: string) {
  const now = Date.now()
  db().prepare(`
    INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
    VALUES (?, ?, 'member', ?, ?)
  `).run(orgId, tokenIdentifier, now, now)
}

async function registerSession(authority: ReturnType<typeof setup>["authority"], workspaceId: string, sessionId: string) {
  await authority.reserveSession(alice, { operationId: `op_${sessionId}`, sessionId, workspaceId, kind: "create" })
  await authority.registerRuntimeSession({
    createdAt: Date.now(),
    updatedAt: Date.now(),
    principalKind: "user",
    actorId: alice.user.tokenIdentifier,
    actorKind: "human",
    operationId: `op_${sessionId}`,
    workspaceId,
    sessionId,
  })
}

function refusal(pending: Promise<unknown>) {
  return pending.then(
    () => "admitted",
    (error: { code?: unknown; status?: unknown; message?: unknown }) => ({ code: error.code, status: error.status, message: error.message }),
  )
}

/** Alice's organization with Bob as a plain member, and a workspace of Alice's in it. */
async function sharedOrganization(workspaceId: string) {
  const { authority, db } = setup()
  await authority.usersMe(alice)
  await authority.usersMe(bob)
  const org = await authority.createOrg!(alice, { name: "Acme" }) as { org_id: string; default_team_id: string }
  addOrgMember(db, org.org_id, bob.user.tokenIdentifier)
  await authority.createCloudWorkspace(alice, { workspaceId, projectId: `prj_${workspaceId}`, displayName: "Repo", orgId: org.org_id })
  return { authority, db, org }
}

describe("sqlite Org→Team + session share", () => {
  test("createOrg seeds default team; team session share unlocks list and revoke fans out", async () => {
    const { authority, db } = setup()
    await authority.usersMe(alice)
    await authority.usersMe(bob)

    const org = await authority.createOrg!(alice, { name: "Acme" }) as {
      org_id: string
      default_team_id: string
    }
    expect(org.default_team_id).toMatch(/^team_/)
    addOrgMember(db, org.org_id, bob.user.tokenIdentifier)

    const teams = await authority.listTeams!(alice, { orgId: org.org_id }) as Array<{
      team_id: string
      is_default?: boolean
    }>
    expect(teams).toEqual(expect.arrayContaining([
      expect.objectContaining({ team_id: org.default_team_id, is_default: true }),
    ]))

    await authority.addTeamMember!(alice, {
      teamId: org.default_team_id,
      tokenIdentifier: bob.user.tokenIdentifier,
      role: "member",
    })

    await expect(authority.listTeamMembers!(alice, { teamId: org.default_team_id })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: bob.user.tokenIdentifier,
          token_identifier: bob.user.tokenIdentifier,
          provider_subject: bob.user.subject,
          role: "member",
        }),
      ]),
    )

    await authority.createCloudWorkspace(alice, {
      workspaceId: "ws_team_share",
      displayName: "Shared repo",
      orgId: org.org_id,
    })
    await authority.ensureDefaultTeam!(alice, { orgId: org.org_id })

    await authority.reserveSession(alice, {
      operationId: "op_team_private",
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      kind: "create",
      title: "Private",
    })
    await authority.registerRuntimeSession({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      principalKind: "user",
      actorId: alice.user.tokenIdentifier,
      actorKind: "human",
      operationId: "op_team_private",
      workspaceId: "ws_team_share",
      sessionId: "ses_private",
      title: "Private",
    })

    expect(await authority.listSessions(bob, { workspaceId: "ws_team_share" })).toEqual([])

    const grant = await authority.grantSessionShare!(alice, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      grantedToTeamId: org.default_team_id,
    }) as { grant_id: string }
    expect(grant.grant_id).toMatch(/^ssg_/)

    const listed = await authority.listSessions(bob, { workspaceId: "ws_team_share" }) as Array<{
      session_id: string
      owner_name?: string
      owner_avatar_url?: string
      owner_public_id?: string
    }>
    expect(listed.map((row) => row.session_id)).toContain("ses_private")
    const bobRow = listed.find((row) => row.session_id === "ses_private")
    // Fixture users have public_id but no display name — still expose owner mark for Bob.
    expect(bobRow?.owner_public_id).toMatch(/^usr_/)

    const aliceListed = await authority.listSessions(alice, { workspaceId: "ws_team_share" }) as Array<{
      session_id: string
      owner_name?: string
      owner_public_id?: string
    }>
    const aliceRow = aliceListed.find((row) => row.session_id === "ses_private")
    expect(aliceRow?.owner_name).toBeUndefined()
    expect(aliceRow?.owner_public_id).toBeUndefined()

    await expect(authority.readSessionMessages(bob, {
      workspaceId: "ws_team_share",
      sessionId: "ses_private",
    })).resolves.toMatchObject({ allowed: true })

    await expect(authority.listSessionShares!(bob, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
    })).resolves.toEqual({
      can_manage_shares: false,
      grants: [],
      participants: [],
      teams: [],
    })

    await expect(authority.grantSessionShare!(bob, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      grantedToTeamId: org.default_team_id,
    })).rejects.toThrow("session_share_admin_required")

    await expect(authority.revokeSessionShare!(bob, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      grantId: grant.grant_id,
    })).rejects.toThrow("session_share_admin_required")

    await expect(authority.listSessionShares!(alice, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
    })).resolves.toMatchObject({
      can_manage_shares: true,
      teams: [{
        team_id: org.default_team_id,
        name: "Everyone",
        is_shared: true,
      }],
    })

    const revoked = await authority.revokeSessionShare!(alice, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      grantId: grant.grant_id,
    }) as {
      revoked: boolean
      revokedTargets: Array<{ grantedToTeamPublicId?: string }>
    }
    expect(revoked).toMatchObject({
      revoked: true,
      revokedTargets: [{ grantedToTeamPublicId: org.default_team_id }],
    })
    expect(await authority.listSessions(bob, { workspaceId: "ws_team_share" })).toEqual([])
    await expect(authority.readSessionMessages(bob, {
      workspaceId: "ws_team_share",
      sessionId: "ses_private",
    })).resolves.toEqual({ allowed: false, messages: [] })

    await expect(authority.listSessionShares!(bob, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
    })).rejects.toThrow("session_share_admin_required")
    // A session this authority does not hold has no shares: its workspace's
    // owner gets a definite empty answer and anyone else is refused.
    await expect(authority.listSessionShares!(alice, {
      sessionId: "ses_missing",
      workspaceId: "ws_team_share",
    })).resolves.toEqual({ can_manage_shares: false, grants: [], participants: [], teams: [] })
    await expect(authority.listSessionShares!(signedAuth("stranger"), {
      sessionId: "ses_missing",
      workspaceId: "ws_team_share",
    })).rejects.toThrow("session_share_admin_required")

    const stranger = signedAuth("stranger")
    await authority.usersMe(stranger)
    await expect(authority.grantSessionShare!(alice, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      grantedToTokenIdentifier: stranger.user.tokenIdentifier,
    })).rejects.toThrow("session_share_target_outside_organization")

    const userGrant = await authority.grantSessionShare!(alice, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      grantedToTokenIdentifier: bob.user.tokenIdentifier,
    }) as { grant_id: string }
    db().prepare(`UPDATE org_memberships SET role = 'admin' WHERE org_id = ? AND token_identifier = ?`)
      .run(org.org_id, bob.user.tokenIdentifier)
    await expect(authority.listSessionShares!(bob, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
    })).resolves.toEqual({ can_manage_shares: false, grants: [], participants: [], teams: [] })
    await expect(authority.grantSessionShare!(bob, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      grantedToTeamId: org.default_team_id,
    })).rejects.toThrow("session_share_admin_required")
    await expect(authority.revokeSessionShare!(bob, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      grantId: userGrant.grant_id,
    })).rejects.toThrow("session_share_admin_required")

    db().prepare(`UPDATE org_memberships SET role = 'member' WHERE org_id = ? AND token_identifier = ?`)
      .run(org.org_id, bob.user.tokenIdentifier)
    db().prepare(`UPDATE team_memberships SET role = 'admin' WHERE team_id = ? AND user_token_identifier = ?`)
      .run(org.default_team_id, bob.user.tokenIdentifier)
    await expect(authority.listSessionShares!(bob, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
    })).resolves.toEqual({ can_manage_shares: false, grants: [], participants: [], teams: [] })
    await expect(authority.grantSessionShare!(bob, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      grantedToTeamId: org.default_team_id,
    })).rejects.toThrow("session_share_admin_required")
    await expect(authority.revokeSessionShare!(bob, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      grantId: userGrant.grant_id,
    })).rejects.toThrow("session_share_admin_required")

    await expect(authority.listSessionShares!(alice, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
    })).resolves.toMatchObject({
      can_manage_shares: true,
      grants: [expect.objectContaining({ grant_id: userGrant.grant_id, granted_to_user_id: bob.user.tokenIdentifier })],
    })
    await expect(authority.revokeSessionShare!(alice, {
      sessionId: "ses_private",
      workspaceId: "ws_team_share",
      grantId: userGrant.grant_id,
    })).resolves.toMatchObject({ revoked: true })

    authority.close()
  })

  test("personal org skips team CRUD; nested team create works on collaborative org", async () => {
    const { authority } = setup()
    await authority.usersMe(alice)
    const personal = await authority.resolveOrgId(alice)
    await expect(authority.createTeamInOrg!(alice, { orgId: personal, name: "Nope" }))
      .rejects.toThrow(/team_not_allowed_on_personal_org|Organization not found/)

    const org = await authority.createOrg!(alice, { name: "Co" }) as { org_id: string }
    const team = await authority.createTeamInOrg!(alice, { orgId: org.org_id, name: "Backend" }) as {
      team_id: string
      name: string
    }
    expect(team).toMatchObject({ name: "Backend" })
    expect(team.team_id).toMatch(/^team_/)
    authority.close()
  })

  test("default-team setup leaves every session share as its owner made it", async () => {
    const { authority, org } = await sharedOrganization("ws_untouched")
    await authority.addTeamMember!(alice, { teamId: org.default_team_id, tokenIdentifier: bob.user.tokenIdentifier, role: "member" })
    await registerSession(authority, "ws_untouched", "ses_org_share")
    await authority.grantSessionShare!(alice, { sessionId: "ses_org_share", workspaceId: "ws_untouched", grantedToOrgId: org.org_id })
    const before = await authority.listSessionShares!(alice, { sessionId: "ses_org_share", workspaceId: "ws_untouched" })
    expect(before.grants).toEqual([expect.objectContaining({ granted_to_org_id: org.org_id, granted_to_team_id: null })])

    const result = await authority.ensureDefaultTeam!(alice, { orgId: org.org_id })

    expect(await authority.listSessionShares!(alice, { sessionId: "ses_org_share", workspaceId: "ws_untouched" })).toEqual(before)
    expect(result).toEqual({ team_id: org.default_team_id, org_id: org.org_id })
    authority.close()
  })

  test("a former team member loses everything the team gave them, and re-adding them restores it", async () => {
    const { authority, org } = await sharedOrganization("ws_former")
    await authority.ensureDefaultTeam!(alice, { orgId: org.org_id })
    await registerSession(authority, "ws_former", "ses_former")
    await authority.grantSessionShare!(alice, { sessionId: "ses_former", workspaceId: "ws_former", grantedToTeamId: org.default_team_id })
    const reach = async () => ({
      listed: (await authority.listSessions(bob, { workspaceId: "ws_former" }) as Array<{ session_id: string }>).map((row) => row.session_id),
      read: (await authority.readSessionMessages(bob, { workspaceId: "ws_former", sessionId: "ses_former" }) as { allowed: boolean }).allowed,
      runtime: await authority.authorizeRuntimeSession({
        principalKind: "user",
        actorId: bob.user.tokenIdentifier,
        actorKind: "human",
        sessionId: "ses_former",
        workspaceId: "ws_former",
        action: "read",
      }).then(() => true, () => false),
      shares: await authority.listSessionShares!(bob, { sessionId: "ses_former", workspaceId: "ws_former" }).then(() => true, () => false),
      projectRole: await authority.projectRole(bob, { projectId: asProjectId("prj_ws_former") }).then((result) => result.ok && result.role),
      teamMember: (await authority.listTeamMembers!(alice, { teamId: org.default_team_id }) as Array<{ user_id: string }>)
        .some((row) => row.user_id === bob.user.tokenIdentifier),
    })
    const asMember = { listed: ["ses_former"], read: true, runtime: true, shares: true, projectRole: "editor", teamMember: true }
    expect(await reach()).toEqual(asMember)

    await authority.removeTeamMember!(alice, { teamId: org.default_team_id, tokenIdentifier: bob.user.tokenIdentifier })
    expect(await reach()).toEqual({ listed: [], read: false, runtime: false, shares: false, projectRole: "viewer", teamMember: false })

    await authority.addTeamMember!(alice, { teamId: org.default_team_id, tokenIdentifier: bob.user.tokenIdentifier, role: "member" })
    expect(await reach()).toEqual(asMember)
    authority.close()
  })

  test("share listing refuses another person's session, an unregistered one and an unknown workspace alike", async () => {
    const { authority } = await sharedOrganization("ws_listing")
    const carol = signedAuth("carol")
    await authority.usersMe(carol)
    await registerSession(authority, "ws_listing", "ses_listed")
    const list = (who: SignedControlPlaneAuth, workspaceId: string, sessionId: string) =>
      refusal(authority.listSessionShares!(who, { workspaceId, sessionId }))

    const refused = await list(bob, "ws_listing", "ses_listed")
    expect(refused).toMatchObject({ code: "session_share_admin_required" })
    for (const who of [bob, carol]) {
      for (const [workspaceId, sessionId] of [
        ["ws_listing", "ses_listed"],
        ["ws_listing", "ses_unregistered"],
        ["ws_unknown", "ses_unregistered"],
        ["ws_unknown", "ses_listed"],
      ]) {
        expect(await list(who, workspaceId, sessionId)).toEqual(refused)
      }
    }
    expect(await list(alice, "ws_unknown", "ses_unregistered")).toEqual(refused)
    await expect(authority.listSessionShares!(alice, { workspaceId: "ws_listing", sessionId: "ses_unregistered" }))
      .resolves.toEqual({ can_manage_shares: false, grants: [], participants: [], teams: [] })
    authority.close()
  })

  test("revoking a team share leaves the workspace owner's runtime token active", async () => {
    const { authority, org } = await sharedOrganization("ws_tokens")
    await registerSession(authority, "ws_tokens", "ses_tokens")
    await authority.recordRuntimeAccessToken(alice, {
      jti: "rat_owner",
      workspaceId: "ws_tokens",
      hostId: "host_tokens",
      actorId: alice.user.tokenIdentifier,
      actorKind: "human",
      role: "owner",
      expiresAt: Date.now() + 600_000,
    })
    const grant = await authority.grantSessionShare!(alice, {
      sessionId: "ses_tokens",
      workspaceId: "ws_tokens",
      grantedToTeamId: org.default_team_id,
    })

    const revoked = await authority.revokeSessionShare!(alice, { sessionId: "ses_tokens", workspaceId: "ws_tokens", grantId: grant.grant_id })

    await expect(authority.runtimeAccessTokenActive({ jti: "rat_owner", workspaceId: "ws_tokens", hostId: "host_tokens" }))
      .resolves.toEqual({ active: true })
    expect(revoked).toEqual({ revoked: true, runtime_tokens_revoked: 0, revokedTargets: [{ grantedToTeamPublicId: org.default_team_id }] })
    authority.close()
  })
})
