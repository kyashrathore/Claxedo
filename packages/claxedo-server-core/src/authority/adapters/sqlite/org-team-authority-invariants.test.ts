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

const alice = signedAuth("alice")
const bob = signedAuth("bob")

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
})
