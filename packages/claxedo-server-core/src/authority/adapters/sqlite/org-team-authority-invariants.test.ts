import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createSqliteWorkspaceAuthority } from "./workspace-authority"
import { closeAuthorityDatabases, openAuthorityDb } from "./workspace-authority-store"

const roots: string[] = []

afterEach(() => {
  closeAuthorityDatabases()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

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

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-org-team-invariants-"))
  roots.push(root)
  const file = path.join(root, "authority.sqlite")
  return {
    authority: createSqliteWorkspaceAuthority({ path: file }),
    db: openAuthorityDb({ path: file }),
  }
}

function addOrgMember(db: ReturnType<typeof setup>["db"], orgId: string, tokenIdentifier: string) {
  const now = Date.now()
  db().prepare(`
    INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
    VALUES (?, ?, 'member', ?, ?)
  `).run(orgId, tokenIdentifier, now, now)
}

function refusal(pending: Promise<unknown>) {
  return pending.then(
    () => "admitted",
    (error: { code?: unknown; status?: unknown; message?: unknown }) => ({ code: error.code, status: error.status, message: error.message }),
  )
}

const alice = signedAuth("alice")
const bob = signedAuth("bob")
const carol = signedAuth("carol")

describe("SQLite organization/team authority invariants", () => {
  test("team membership requires canonical membership in the team's organization", async () => {
    const { authority, db } = setup()
    await authority.usersMe(alice)
    await authority.usersMe(bob)
    const org = (await authority.createOrg!(alice, { name: "Acme" })) as {
      org_id: string
      default_team_id: string
    }

    await expect(
      authority.addTeamMember!(alice, {
        teamId: org.default_team_id,
        tokenIdentifier: bob.user.tokenIdentifier,
        role: "member",
      }),
    ).rejects.toThrow("team_member_org_membership_required")
    await expect(
      authority.addTeamMember!(alice, { teamId: org.default_team_id, tokenIdentifier: "issuer|no-such-account", role: "member" }),
    ).rejects.toThrow("team_member_org_membership_required")

    const now = Date.now()
    db()
      .prepare(
        `
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
      VALUES (?, ?, 'member', ?, ?)
    `,
      )
      .run(org.org_id, bob.user.tokenIdentifier, now, now)

    await expect(
      authority.addTeamMember!(alice, {
        teamId: org.default_team_id,
        tokenIdentifier: bob.user.tokenIdentifier,
        role: "member",
      }),
    ).resolves.toMatchObject({ role: "member" })
  })

  test("default-team provisioning preserves an explicit project revocation", async () => {
    const { authority, db } = setup()
    await authority.usersMe(alice)
    const org = (await authority.createOrg!(alice, { name: "Acme" })) as {
      org_id: string
      default_team_id: string
    }
    await authority.createCloudWorkspace(alice, {
      workspaceId: "ws_revoked_default_team",
      projectId: "prj_revoked_default_team",
      orgId: org.org_id,
      displayName: "Revoked default team",
    })
    await authority.ensureDefaultTeam!(alice, { orgId: org.org_id })
    await authority.revokeTeamProject!(alice, {
      teamId: org.default_team_id,
      projectId: "prj_revoked_default_team",
    })

    await authority.ensureDefaultTeam!(alice, { orgId: org.org_id })

    const grant = db()
      .prepare(
        `
      SELECT role, revoked_at FROM team_project_grants WHERE team_id = ? AND project_id = ?
    `,
      )
      .get(org.default_team_id, "prj_revoked_default_team") as { role: string; revoked_at: number | null }
    expect(grant).toMatchObject({ role: "editor", revoked_at: expect.any(Number) })
  })

  test("a member removed from the default team cannot restore themselves, and an administrator's setup leaves them removed", async () => {
    const { authority, db } = setup()
    await authority.usersMe(alice)
    await authority.usersMe(bob)
    const org = (await authority.createOrg!(alice, { name: "Acme" })) as { org_id: string; default_team_id: string }
    addOrgMember(db, org.org_id, bob.user.tokenIdentifier)
    await authority.ensureDefaultTeam!(alice, { orgId: org.org_id })
    const members = async () =>
      ((await authority.listTeamMembers!(alice, { teamId: org.default_team_id })) as Array<{ user_id: string }>).map((row) => row.user_id)
    expect(await members()).toContain(bob.user.tokenIdentifier)

    await authority.removeTeamMember!(alice, { teamId: org.default_team_id, tokenIdentifier: bob.user.tokenIdentifier })
    await expect(authority.ensureDefaultTeam!(bob, { orgId: org.org_id })).rejects.toMatchObject({ code: "org_admin_required" })
    expect(await members()).not.toContain(bob.user.tokenIdentifier)
    await authority.ensureDefaultTeam!(alice, { orgId: org.org_id })
    expect(await members()).not.toContain(bob.user.tokenIdentifier)

    await authority.addTeamMember!(alice, { teamId: org.default_team_id, tokenIdentifier: bob.user.tokenIdentifier, role: "member" })
    expect(await members()).toContain(bob.user.tokenIdentifier)
  })

  test("an organization or team the caller does not administer answers exactly like one that does not exist", async () => {
    const { authority, db } = setup()
    await authority.usersMe(alice)
    await authority.usersMe(bob)
    await authority.usersMe(carol)
    const org = (await authority.createOrg!(alice, { name: "Acme" })) as { org_id: string; default_team_id: string }
    addOrgMember(db, org.org_id, bob.user.tokenIdentifier)
    await authority.createCloudWorkspace(alice, {
      workspaceId: "ws_oracle",
      projectId: "prj_oracle",
      orgId: org.org_id,
      displayName: "Oracle",
    })
    const orgCalls = (who: SignedControlPlaneAuth, orgId: string) => [
      authority.createTeamInOrg!(who, { orgId, name: "Probe" }),
      authority.ensureDefaultTeam!(who, { orgId }),
    ]
    const teamCalls = (who: SignedControlPlaneAuth, teamId: string) => [
      authority.addTeamMember!(who, { teamId, tokenIdentifier: bob.user.tokenIdentifier, role: "member" }),
      authority.removeTeamMember!(who, { teamId, tokenIdentifier: alice.user.tokenIdentifier }),
      authority.grantTeamProject!(who, { teamId, projectId: "prj_oracle", role: "viewer" }),
      authority.revokeTeamProject!(who, { teamId, projectId: "prj_oracle" }),
    ]

    for (const who of [bob, carol]) {
      const absentOrg = await Promise.all(orgCalls(who, "org_absent").map(refusal))
      expect(absentOrg.map((answer) => (answer as { code: string }).code)).toEqual(["org_admin_required", "org_admin_required"])
      expect(await Promise.all(orgCalls(who, org.org_id).map(refusal))).toEqual(absentOrg)
      const absentTeam = await Promise.all(teamCalls(who, "team_absent").map(refusal))
      expect(absentTeam.map((answer) => (answer as { code: string }).code)).toEqual(Array(4).fill("team_not_found"))
      expect(await Promise.all(teamCalls(who, org.default_team_id).map(refusal))).toEqual(absentTeam)
    }
  })
})
