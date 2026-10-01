import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { asProjectId } from "@claxedo/server-core/platform/auth/branded-id"
import { createSqliteWorkspaceAuthority } from "./workspace-authority"
import { closeAuthorityDatabases, openAuthorityDb, type SqliteAuthorityDb } from "./workspace-authority-store"

const roots: string[] = []

afterEach(() => {
  closeAuthorityDatabases()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function signed(tokenIdentifier: string): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: `token:${tokenIdentifier}`,
    user: {
      subject: tokenIdentifier,
      tokenIdentifier,
      issuer: "https://issuer.example.test",
    },
  }
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-authority-policy-"))
  roots.push(root)
  const file = path.join(root, "authority.sqlite")
  return {
    authority: createSqliteWorkspaceAuthority({ path: file }),
    db: openAuthorityDb({ path: file }),
  }
}

function addOrgMember(db: () => SqliteAuthorityDb, workspaceId: string, tokenIdentifier: string, role: string) {
  const now = Date.now()
  const database = db()
  const workspace = database.prepare("SELECT org_id FROM workspaces WHERE workspace_id = ?")
    .get(workspaceId) as { org_id: string }
  database.prepare(`
    INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (org_id, token_identifier) DO UPDATE SET role = excluded.role
  `).run(workspace.org_id, tokenIdentifier, role, now, now)
}

async function createSessionAs(
  authority: ReturnType<typeof setup>["authority"],
  creator: SignedControlPlaneAuth,
  sessionId: string,
) {
  const operationId = `op_create_${sessionId}`
  await authority.reserveSession(creator, { operationId, workspaceId: "ws_1", sessionId, kind: "create" })
  await authority.registerRuntimeSession({
    createdAt: Date.now(),
    updatedAt: Date.now(),
    principalKind: "user",
    actorId: creator.user.tokenIdentifier,
    actorKind: "human",
    operationId,
    workspaceId: "ws_1",
    sessionId,
  })
  await authority.upsertSessionVisibility(creator, { workspaceId: "ws_1", sessions: [{ sessionId }] })
}

describe("SQLite workspace session authority", () => {
  test("only the owner creates sessions, and only a share crosses people", async () => {
    const { authority, db } = setup()
    const owner = signed("owner")
    const member = signed("member")
    await Promise.all([authority.usersMe(owner), authority.usersMe(member)])
    await authority.createCloudWorkspace(owner, {
      workspaceId: "ws_1",
      displayName: "Workspace",
      repoUrl: "https://github.com/acme/repo.git",
    })
    addOrgMember(db, "ws_1", "member", "admin")
    await createSessionAs(authority, owner, "ses_1")
    await expect(createSessionAs(authority, member, "ses_member")).rejects.toMatchObject({ status: 403 })

    await expect(authority.authorizeSessionRead(member, { workspaceId: "ws_1", sessionId: "ses_1" }))
      .rejects.toMatchObject({ status: 403 })

    await authority.grantSessionShare!(owner, { workspaceId: "ws_1", sessionId: "ses_1", grantedToTokenIdentifier: "member" })
    await expect(authority.authorizeSessionRead(member, { workspaceId: "ws_1", sessionId: "ses_1" })).resolves.toBeUndefined()
  })

  test("a workspace handed to a member is theirs, and the organization's founder ranks nothing on it", async () => {
    const { authority, db } = setup()
    const founder = signed("founder")
    const member = signed("member")
    await Promise.all([authority.usersMe(founder), authority.usersMe(member)])
    await authority.createCloudWorkspace(founder, {
      workspaceId: "ws_1",
      displayName: "Workspace",
      repoUrl: "https://github.com/acme/repo.git",
    })
    addOrgMember(db, "ws_1", "member", "member")
    db().prepare("UPDATE workspaces SET owner_token_identifier = ? WHERE workspace_id = ?").run("member", "ws_1")
    await createSessionAs(authority, member, "ses_1")

    await expect(authority.openWorkspace(member, { workspaceId: "ws_1" })).resolves.toMatchObject({ role: "owner" })
    await expect(authority.openWorkspace(founder, { workspaceId: "ws_1" })).rejects.toMatchObject({ status: 403 })
    await expect(authority.listSessions(founder, { workspaceId: "ws_1" })).resolves.toEqual([])
    await expect(authority.authorizeSessionRead(founder, { workspaceId: "ws_1", sessionId: "ses_1" }))
      .rejects.toMatchObject({ status: 403 })
  })

  test("a project grant, a team grant or project ownership admits nothing to someone outside the project's organization", async () => {
    const { authority, db } = setup()
    const founder = signed("founder")
    const outsider = signed("outsider")
    await Promise.all([authority.usersMe(founder), authority.usersMe(outsider)])
    const org = await authority.createOrg!(founder, { name: "Acme" }) as { org_id: string; default_team_id: string }
    await authority.createCloudWorkspace(founder, { workspaceId: "ws_1", projectId: "prj_1", orgId: org.org_id, displayName: "Workspace" })
    await authority.ensureDefaultTeam!(founder, { orgId: org.org_id })
    const now = Date.now()
    const standings = {
      "a direct project grant": () => db().prepare(`
        INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at) VALUES ('prj_1', 'outsider', 'editor', ?, ?)
      `).run(now, now),
      "a team grant": () => db().prepare(`
        INSERT INTO team_memberships (team_id, user_token_identifier, role, created_at, updated_at) VALUES (?, 'outsider', 'member', ?, ?)
      `).run(org.default_team_id, now, now),
      "project ownership": () => db().prepare(`UPDATE projects SET owner_token_identifier = 'outsider' WHERE project_id = 'prj_1'`).run(),
    }

    for (const [standing, give] of Object.entries(standings)) {
      give()
      await expect(authority.projectRole(outsider, { projectId: asProjectId("prj_1") }), standing).resolves.toEqual({ ok: false })
      await expect(authority.authorizeProject(outsider, { projectId: asProjectId("prj_1"), action: "read" }), standing).resolves.toEqual({ ok: false })
    }
    db().prepare(`
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at) VALUES (?, 'outsider', 'member', ?, ?)
    `).run(org.org_id, now, now)
    await expect(authority.projectRole(outsider, { projectId: asProjectId("prj_1") })).resolves.toMatchObject({ ok: true, role: "owner" })
  })
})
