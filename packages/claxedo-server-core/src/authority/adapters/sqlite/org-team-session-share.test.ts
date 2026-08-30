import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createSqliteWorkspaceAuthority } from "./workspace-authority"
import { closeAuthorityDatabases } from "./workspace-authority-store"

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
})

describe("sqlite Org→Team + session share", () => {
  test("createOrg seeds default team; team session share unlocks list and revoke fans out", async () => {
    const authority = createSqliteWorkspaceAuthority({ path: ":memory:" })
    await authority.usersMe(alice)
    await authority.usersMe(bob)

    const org = await authority.createOrg!(alice, { name: "Acme" }) as {
      org_id: string
      default_team_id: string
    }
    expect(org.default_team_id).toMatch(/^team_/)

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

    await authority.createCloudWorkspace(alice, {
      workspaceId: "ws_team_share",
      displayName: "Shared repo",
      orgId: org.org_id,
    })
    await authority.ensureDefaultTeam!(alice, { orgId: org.org_id })
    await authority.grantWorkspaceShare(alice, {
      workspaceId: "ws_team_share",
      role: "editor",
      grantedToTeamId: org.default_team_id,
    })

    await authority.registerRuntimeSession!({
      actorId: alice.user.tokenIdentifier,
      actorKind: "human",
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

    authority.close()
  })

  test("personal org skips team CRUD; nested team create works on collaborative org", async () => {
    const authority = createSqliteWorkspaceAuthority({ path: ":memory:" })
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

  test("ensureDefaultTeam retargets org session and workspace shares onto the default team", async () => {
    const authority = createSqliteWorkspaceAuthority({ path: ":memory:" })
    await authority.usersMe(alice)
    await authority.usersMe(bob)

    const org = await authority.createOrg!(alice, { name: "Retarget Co" }) as {
      org_id: string
      default_team_id: string
    }
    await authority.addTeamMember!(alice, {
      teamId: org.default_team_id,
      tokenIdentifier: bob.user.tokenIdentifier,
      role: "member",
    })
    await authority.createCloudWorkspace(alice, {
      workspaceId: "ws_retarget",
      displayName: "Repo",
      orgId: org.org_id,
    })

    // Interim org-targeted workspace share (pre-nesting shape).
    await authority.grantWorkspaceShare(alice, {
      workspaceId: "ws_retarget",
      role: "editor",
      grantedToClerkOrgId: org.org_id,
    })

    await authority.registerRuntimeSession!({
      actorId: alice.user.tokenIdentifier,
      actorKind: "human",
      workspaceId: "ws_retarget",
      sessionId: "ses_org_share",
      title: "Shared via org",
    })
    await authority.grantSessionShare!(alice, {
      sessionId: "ses_org_share",
      workspaceId: "ws_retarget",
      grantedToOrgId: org.org_id,
    })

    const result = await authority.ensureDefaultTeam!(alice, { orgId: org.org_id }) as {
      session_shares_retargeted: number
      workspace_shares_retargeted: number
      team_id: string
    }
    expect(result.team_id).toBe(org.default_team_id)
    expect(result.session_shares_retargeted).toBeGreaterThanOrEqual(1)
    expect(result.workspace_shares_retargeted).toBeGreaterThanOrEqual(1)

    const shares = await authority.listSessionShares!(alice, {
      sessionId: "ses_org_share",
      workspaceId: "ws_retarget",
    }) as {
      grants: Array<{ granted_to_org_id: string | null; granted_to_team_id: string | null }>
    }
    expect(shares.grants).toEqual([
      expect.objectContaining({
        granted_to_org_id: null,
        granted_to_team_id: org.default_team_id,
      }),
    ])

    const listed = await authority.listSessions(bob, { workspaceId: "ws_retarget" }) as Array<{
      session_id: string
    }>
    expect(listed.map((row) => row.session_id)).toContain("ses_org_share")
    authority.close()
  })
})
