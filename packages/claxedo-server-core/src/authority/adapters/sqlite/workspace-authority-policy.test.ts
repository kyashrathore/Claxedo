import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
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

/** Withholds the implicit member rank, leaving org membership with no workspace standing of its own. */
function hideFromOrgMembers(db: () => SqliteAuthorityDb, workspaceId: string) {
  db().prepare("UPDATE workspaces SET org_member_visible = 0 WHERE workspace_id = ?").run(workspaceId)
}

async function createSessionAs(
  authority: ReturnType<typeof setup>["authority"],
  creator: SignedControlPlaneAuth,
  sessionId: string,
) {
  const operationId = `op_create_${sessionId}`
  await authority.reserveSession(creator, { operationId, workspaceId: "ws_1", sessionId, kind: "create" })
  await authority.registerRuntimeSession({
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
  test("participant administration rests on the creator alone, not on workspace standing", async () => {
    const { authority, db } = setup()
    const owner = signed("owner")
    const creator = signed("creator")
    const participant = signed("participant")
    await Promise.all([authority.usersMe(owner), authority.usersMe(creator), authority.usersMe(participant)])
    await authority.createCloudWorkspace(owner, {
      workspaceId: "ws_1",
      displayName: "Workspace",
      repoUrl: "https://github.com/acme/repo.git",
    })
    // An org admin ranks `admin` on the workspace even where the implicit
    // member rank is withheld, so downgrading them to member below takes the
    // rank away while their organization standing — which every session
    // decision still asks for — is untouched.
    addOrgMember(db, "ws_1", "creator", "admin")
    addOrgMember(db, "ws_1", "participant", "member")
    hideFromOrgMembers(db, "ws_1")
    await createSessionAs(authority, creator, "ses_1")

    await expect(authority.grantSessionParticipant(owner, {
      workspaceId: "ws_1",
      sessionId: "ses_1",
      participantActorId: "participant",
    })).rejects.toMatchObject({ status: 403 })

    addOrgMember(db, "ws_1", "creator", "member")
    await expect(authority.openWorkspace(creator, { workspaceId: "ws_1" })).rejects.toMatchObject({ status: 403 })
    await expect(authority.grantSessionParticipant(creator, {
      workspaceId: "ws_1",
      sessionId: "ses_1",
      participantActorId: "participant",
    })).resolves.toEqual({ participant_id: "participant" })

    await expect(authority.authorizeSessionRead(participant, {
      workspaceId: "ws_1",
      sessionId: "ses_1",
    })).resolves.toBeUndefined()
    await expect(authority.grantSessionParticipant(participant, {
      workspaceId: "ws_1",
      sessionId: "ses_1",
      participantActorId: "owner",
    })).rejects.toMatchObject({ code: "actor_authorization_denied" })
  })

  test("durable organization ownership ranks the workspace and never admits to a session", async () => {
    const { authority, db } = setup()
    const owner = signed("owner")
    const creator = signed("creator")
    const participant = signed("participant")
    await Promise.all([authority.usersMe(owner), authority.usersMe(creator), authority.usersMe(participant)])
    await authority.createCloudWorkspace(owner, {
      workspaceId: "ws_1",
      displayName: "Workspace",
      repoUrl: "https://github.com/acme/repo.git",
    })
    addOrgMember(db, "ws_1", "creator", "admin")
    await createSessionAs(authority, creator, "ses_1")
    const database = db()
    const workspace = database.prepare("SELECT org_id, project_id FROM workspaces WHERE workspace_id = ?")
      .get("ws_1") as { org_id: string; project_id: string }
    database.prepare("UPDATE workspaces SET owner_token_identifier = ? WHERE workspace_id = ?")
      .run("creator", "ws_1")
    database.prepare("UPDATE projects SET owner_token_identifier = ? WHERE project_id = ?")
      .run("creator", workspace.project_id)
    database.prepare("DELETE FROM project_memberships WHERE project_id = ? AND token_identifier = ?")
      .run(workspace.project_id, "owner")
    database.prepare("DELETE FROM org_memberships WHERE org_id = ? AND token_identifier = ?")
      .run(workspace.org_id, "owner")

    await expect(authority.openWorkspace(owner, { workspaceId: "ws_1" })).resolves.toMatchObject({ role: "admin" })
    await expect(authority.listSessions(owner, { workspaceId: "ws_1" })).resolves.toEqual([])
    await expect(authority.authorizeSessionRead(owner, {
      workspaceId: "ws_1",
      sessionId: "ses_1",
    })).rejects.toMatchObject({ status: 403 })

    database.prepare(`
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
      VALUES (?, ?, 'member', ?, ?)
    `).run(workspace.org_id, "owner", Date.now(), Date.now())

    await expect(authority.openWorkspace(owner, { workspaceId: "ws_1" })).resolves.toMatchObject({ role: "viewer" })
    await expect(authority.listSessions(owner, { workspaceId: "ws_1" })).resolves.toEqual([])
    await expect(authority.authorizeSessionRead(owner, {
      workspaceId: "ws_1",
      sessionId: "ses_1",
    })).rejects.toMatchObject({ status: 403 })
    await expect(authority.grantSessionParticipant(owner, {
      workspaceId: "ws_1",
      sessionId: "ses_1",
      participantActorId: "participant",
    })).rejects.toMatchObject({ status: 403 })
  })
})
