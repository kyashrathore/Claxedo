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

describe("SQLite workspace session authority", () => {
  test("revoked creators cannot manage participants", async () => {
    const { authority } = setup()
    const owner = signed("owner")
    const creator = signed("creator")
    const participant = signed("participant")
    await Promise.all([authority.usersMe(owner), authority.usersMe(creator), authority.usersMe(participant)])
    await authority.createCloudWorkspace(owner, {
      workspaceId: "ws_1",
      displayName: "Workspace",
      repoUrl: "https://github.com/acme/repo.git",
    })
    await authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_1",
      role: "editor",
      target: { kind: "actor", actorId: "creator" },
    })
    await authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_1",
      role: "viewer",
      target: { kind: "actor", actorId: "participant" },
    })
    await authority.reserveSession(creator, {
      operationId: "op_create_ses_1",
      workspaceId: "ws_1",
      sessionId: "ses_1",
      kind: "create",
    })
    await authority.registerRuntimeSession!({
      principalKind: "user",
      actorId: "creator",
      actorKind: "human",
      operationId: "op_create_ses_1",
      workspaceId: "ws_1",
      sessionId: "ses_1",
    })
    await authority.upsertSessionVisibility(creator, {
      workspaceId: "ws_1",
      sessions: [{ sessionId: "ses_1" }],
    })
    await authority.revokeWorkspaceShare(owner, {
      workspaceId: "ws_1",
      target: { kind: "actor", actorId: "creator" },
    })

    await expect(authority.grantSessionParticipant(creator, {
      workspaceId: "ws_1",
      sessionId: "ses_1",
      participantActorId: "participant",
    })).rejects.toMatchObject({ status: 403 })
  })

  test("durable organization ownership is a fallback while a membership row remains authoritative", async () => {
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
    await authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_1",
      role: "editor",
      target: { kind: "actor", actorId: "creator" },
    })
    await authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_1",
      role: "viewer",
      target: { kind: "actor", actorId: "participant" },
    })
    await authority.reserveSession(creator, {
      operationId: "op_create_ses_1",
      workspaceId: "ws_1",
      sessionId: "ses_1",
      kind: "create",
    })
    await authority.registerRuntimeSession!({
      principalKind: "user",
      actorId: "creator",
      actorKind: "human",
      operationId: "op_create_ses_1",
      workspaceId: "ws_1",
      sessionId: "ses_1",
    })
    await authority.upsertSessionVisibility(creator, {
      workspaceId: "ws_1",
      sessions: [{ sessionId: "ses_1" }],
    })
    const database = db()
    const workspace = database.prepare("SELECT org_id, project_id FROM workspaces WHERE workspace_id = ?")
      .get("ws_1") as { org_id: string; project_id: string }
    database.prepare("UPDATE workspaces SET owner_token_identifier = ? WHERE workspace_id = ?")
      .run("creator", "ws_1")
    database.prepare("UPDATE projects SET owner_token_identifier = ? WHERE project_id = ?")
      .run("creator", workspace.project_id)
    database.prepare("DELETE FROM workspace_memberships WHERE workspace_id = ? AND token_identifier = ?")
      .run("ws_1", "owner")
    database.prepare("DELETE FROM project_memberships WHERE project_id = ? AND token_identifier = ?")
      .run(workspace.project_id, "owner")
    database.prepare("DELETE FROM org_memberships WHERE org_id = ? AND token_identifier = ?")
      .run(workspace.org_id, "owner")

    await expect(authority.listSessions(owner, { workspaceId: "ws_1" })).resolves.toMatchObject([
      { session_id: "ses_1" },
    ])
    await expect(authority.authorizeSessionRead(owner, {
      workspaceId: "ws_1",
      sessionId: "ses_1",
    })).resolves.toBeUndefined()
    database.prepare(`
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
      VALUES (?, ?, 'member', ?, ?)
    `).run(workspace.org_id, "owner", Date.now(), Date.now())

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
