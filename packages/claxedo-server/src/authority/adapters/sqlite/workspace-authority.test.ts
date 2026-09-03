import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { localControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ensurePersonalOrg, ensureProject, openAuthorityDb, upsertUser } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"

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

const owner = signedAuth("user_owner")
const other = signedAuth("user_other")

function memoryAuthority() {
  return createSqliteWorkspaceAuthority({ path: ":memory:" })
}

async function registerPrivateSession(input: {
  authority: ReturnType<typeof memoryAuthority>
  auth: SignedControlPlaneAuth
  workspaceId: string
  sessionId: string
  title?: string
}) {
  const operationId = `operation_${input.workspaceId}_${input.sessionId}`
  await input.authority.reserveSession(input.auth, {
    operationId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    kind: "create",
    ...(input.title ? { title: input.title } : {}),
  })
  await input.authority.registerRuntimeSession({
    principalKind: "user",
    actorId: input.auth.user.tokenIdentifier,
    actorKind: "human",
    operationId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    ...(input.title ? { title: input.title } : {}),
  })
}

async function recordUserTurns(input: {
  authority: ReturnType<typeof memoryAuthority>
  auth: SignedControlPlaneAuth
  workspaceId: string
  sessionId: string
  turnIds: string[]
}) {
  let fencingToken = 0
  for (const turnId of input.turnIds) {
    const turn = await input.authority.acquireSessionTurn({
      principalKind: "user",
      actorId: input.auth.user.tokenIdentifier,
      actorKind: "human",
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      turnId,
    })
    fencingToken = turn.fencingToken
    await input.authority.releaseSessionTurn({
      principalKind: "user",
      actorId: input.auth.user.tokenIdentifier,
      actorKind: "human",
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      turnId,
      leaseId: turn.leaseId,
      fencingToken: turn.fencingToken,
    })
  }
  return fencingToken
}

function fileAuthority() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-authority-")), "authority.db")
  return {
    authority: createSqliteWorkspaceAuthority({ path: file }),
    database: openAuthorityDb({ path: file }),
  }
}

describe("sqlite workspace authority", () => {
  test("browser and CLI projections keep one immutable actor kind", async () => {
    const authority = memoryAuthority()
    const cli = { ...owner, tokenKind: "cli" as const }
    const browserIdentity = await authority.usersMe(owner) as { actor_id: string; actor_kind: string }
    const cliIdentity = await authority.usersMe(cli) as { actor_id: string; actor_kind: string }
    const browserAgain = await authority.usersMe(owner) as { actor_id: string; actor_kind: string }
    expect([browserIdentity.actor_id, cliIdentity.actor_id, browserAgain.actor_id])
      .toEqual([owner.user.tokenIdentifier, owner.user.tokenIdentifier, owner.user.tokenIdentifier])
    expect([browserIdentity.actor_kind, cliIdentity.actor_kind, browserAgain.actor_kind])
      .toEqual(["human", "human", "human"])
  })

  test("new authority databases keep event ordinals on session history only", () => {
    const { database } = fileAuthority()
    const db = database()
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)

    expect(columns("session_history")).toContain("max_event_ordinal")
    expect(columns("orgs")).not.toContain("max_event_ordinal")
    database.close()
  })

  test("hard-cuts legacy runtime credentials and provider-shaped channel bindings", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-authority-legacy-")), "authority.db")
    const legacy = new Database(file)
    legacy.exec(`
      CREATE TABLE runtime_access_tokens (
        jti TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        minted_for_token_identifier TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO runtime_access_tokens VALUES ('legacy-jti', 'ws_legacy', 'host_legacy', 'issuer|subject', 9, NULL, 1);
      CREATE TABLE channel_identities (
        channel TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        token_identifier TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY (channel, external_user_id)
      );
      INSERT INTO channel_identities VALUES ('telegram', 'external-legacy', 'issuer|subject', 1, NULL);
    `)
    legacy.close()

    const database = openAuthorityDb({ path: file })
    const db = database()
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)

    expect(columns("runtime_access_tokens")).toEqual(expect.arrayContaining([
      "principal_kind", "actor_id", "actor_kind", "role",
    ]))
    expect(columns("channel_identities")).toContain("binding_id")
    expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_access_tokens").get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM channel_identities").get()).toEqual({ count: 0 })
    database.close()
  })

  test("makes channel revocation retryable without letting a prior actor clear a replacement", async () => {
    const authority = memoryAuthority()
    expect(await authority.bindChannelIdentity(owner, {
      channel: "telegram",
      externalUserId: "external-7",
    })).toMatchObject({ created: true, userId: owner.user.tokenIdentifier })
    expect(await authority.revokeChannelIdentity(owner, {
      channel: "telegram",
      externalUserId: "external-7",
    })).toEqual({ revoked: true })
    expect(await authority.revokeChannelIdentity(owner, {
      channel: "telegram",
      externalUserId: "external-7",
    })).toEqual({ revoked: true })
    expect(await authority.bindChannelIdentity(other, {
      channel: "telegram",
      externalUserId: "external-7",
    })).toMatchObject({ created: true, userId: other.user.tokenIdentifier })
    expect(await authority.revokeChannelIdentity(owner, {
      channel: "telegram",
      externalUserId: "external-7",
    })).toEqual({ revoked: false })
  })

  test("creator owns the workspace; others are denied until a share grant flips it", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_1", displayName: "One" })

    const listed = await authority.listWorkspaces(owner) as Array<{ workspace_id: string; project_id: string; role: string; access: string }>
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ workspace_id: "ws_1", project_id: expect.stringMatching(/^prj_/), role: "owner", access: "cloud" })

    const opened = await authority.openWorkspace(owner, { workspaceId: "ws_1" })
    expect(opened.allowed).toBe(true)
    expect(opened.role).toBe("owner")
    expect(opened.workspace).toMatchObject({ workspace_id: "ws_1", backing: "cloud-vm", access: "cloud" })

    await expect(authority.openWorkspace(other, { workspaceId: "ws_1" })).rejects.toMatchObject({
      status: 403,
      code: "workspace_authorization_denied",
    })
    expect(await authority.listWorkspaces(other)).toEqual([])

    await authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_1",
      role: "editor",
      target: { kind: "actor", actorId: other.user.tokenIdentifier },
    })
    const shared = await authority.openWorkspace(other, { workspaceId: "ws_1" })
    expect(shared.role).toBe("editor")
    expect((await authority.listWorkspaces(other) as unknown[])).toHaveLength(1)

    const revoked = await authority.revokeWorkspaceShare(owner, {
      workspaceId: "ws_1",
      target: { kind: "actor", actorId: other.user.tokenIdentifier },
    })
    expect(revoked).toMatchObject({ revoked: true })
    await expect(authority.openWorkspace(other, { workspaceId: "ws_1" })).rejects.toMatchObject({ status: 403 })
  })

  test("canonical actor shares remain unambiguous when provider subjects collide", async () => {
    const { authority, database } = fileAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_ambiguous_subject", displayName: "Ambiguous" })
    await authority.usersMe(other)
    const now = Date.now()
    database().prepare(`
      INSERT INTO users (
        token_identifier, public_id, subject, issuer, kind, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'human', ?, ?)
    `).run(
      "https://second-idp.example.test|user_other",
      "usr_ambiguous_subject",
      other.user.subject,
      "https://second-idp.example.test",
      now,
      now,
    )
    database().prepare(`
      INSERT INTO workspace_share_grants (
        grant_id, workspace_id, target_key, granted_to_subject, role,
        created_by_token_identifier, created_at
      ) VALUES ('legacy-ambiguous-share', ?, ?, ?, 'editor', ?, ?)
    `).run(
      "ws_ambiguous_subject",
      `subject:${other.user.subject}`,
      other.user.subject,
      owner.user.tokenIdentifier,
      now,
    )

    await expect(authority.openWorkspace(other, { workspaceId: "ws_ambiguous_subject" }))
      .rejects.toMatchObject({ status: 403 })

    await expect(authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_ambiguous_subject",
      role: "editor",
      target: { kind: "actor", actorId: other.user.tokenIdentifier },
    })).resolves.toBeTruthy()
    expect(database().prepare(`
      SELECT COUNT(*) AS count FROM workspace_share_grants WHERE workspace_id = ?
    `).get("ws_ambiguous_subject")).toEqual({ count: 2 })
    authority.close()
    database.close()
  })

  test("keeps canonical actor grants idempotent and revocable", async () => {
    const { authority, database } = fileAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_canonical_share", displayName: "Canonical share" })
    await authority.usersMe(other)

    const subjectGrant = await authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_canonical_share",
      role: "editor",
      target: { kind: "actor", actorId: other.user.tokenIdentifier },
    })
    const tokenGrant = await authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_canonical_share",
      role: "editor",
      target: { kind: "actor", actorId: other.user.tokenIdentifier },
    })
    expect(tokenGrant).toBe(subjectGrant)
    expect(database().prepare(`
      SELECT target_key, COUNT(*) AS count FROM workspace_share_grants
      WHERE workspace_id = ? AND revoked_at IS NULL GROUP BY target_key
    `).all("ws_canonical_share")).toEqual([{
      target_key: `token:${other.user.tokenIdentifier}`,
      count: 1,
    }])

    await authority.recordRuntimeAccessToken(other, {
      jti: "jti_canonical_share",
      workspaceId: "ws_canonical_share",
      hostId: "host_canonical_share",
      actorId: other.user.tokenIdentifier,
      actorKind: "human",
      role: "editor",
      expiresAt: Date.now() + 60_000,
    })
    await expect(authority.revokeWorkspaceShare(owner, {
      workspaceId: "ws_canonical_share",
      target: { kind: "actor", actorId: other.user.tokenIdentifier },
    })).resolves.toMatchObject({ revoked: true, runtime_tokens_revoked: 1 })
    await expect(authority.openWorkspace(other, { workspaceId: "ws_canonical_share" }))
      .rejects.toMatchObject({ status: 403 })
    await expect(authority.runtimeAccessTokenActive({
      jti: "jti_canonical_share",
      workspaceId: "ws_canonical_share",
      hostId: "host_canonical_share",
    })).resolves.toMatchObject({ active: false, code: "runtime_access_token_revoked" })
    authority.close()
    database.close()
  })

  test("revokes a legacy subject grant after that subject becomes a canonical user", async () => {
    const { authority, database } = fileAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_late_subject", displayName: "Late subject" })
    const now = Date.now()
    database().prepare(`
      INSERT INTO workspace_share_grants (
        grant_id, workspace_id, target_key, granted_to_subject, role,
        created_by_token_identifier, created_at
      ) VALUES ('legacy-late-subject', ?, ?, ?, 'editor', ?, ?)
    `).run(
      "ws_late_subject",
      `subject:${other.user.subject}`,
      other.user.subject,
      owner.user.tokenIdentifier,
      now,
    )

    await authority.usersMe(other)
    await expect(authority.openWorkspace(other, { workspaceId: "ws_late_subject" }))
      .resolves.toMatchObject({ role: "editor" })
    await authority.recordRuntimeAccessToken(other, {
      jti: "jti_late_subject",
      workspaceId: "ws_late_subject",
      hostId: "host_late_subject",
      actorId: other.user.tokenIdentifier,
      actorKind: "human",
      role: "editor",
      expiresAt: Date.now() + 60_000,
    })

    await expect(authority.revokeWorkspaceShare(owner, {
      workspaceId: "ws_late_subject",
      target: { kind: "actor", actorId: other.user.tokenIdentifier },
    })).resolves.toMatchObject({ revoked: true, runtime_tokens_revoked: 1 })
    await expect(authority.openWorkspace(other, { workspaceId: "ws_late_subject" }))
      .rejects.toMatchObject({ status: 403 })
    authority.close()
    database.close()
  })

  test("resolves organization share selectors to the canonical local organization", async () => {
    const { authority, database } = fileAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_org_share", displayName: "Org share" })
    await authority.usersMe(other)
    const now = Date.now()
    database().prepare(`
      INSERT INTO orgs (
        org_id, name, kind, owner_token_identifier, created_at, updated_at
      ) VALUES ('org_team', 'Team', 'team', ?, ?, ?)
    `).run(owner.user.tokenIdentifier, now, now)
    database().prepare(`
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
      VALUES ('org_team', ?, 'member', ?, ?)
    `).run(other.user.tokenIdentifier, now, now)

    await authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_org_share",
      role: "editor",
      target: { kind: "org", orgId: "org_team" },
    })
    expect(database().prepare(`
      SELECT target_key, granted_to_org_id FROM workspace_share_grants
      WHERE workspace_id = ? AND revoked_at IS NULL
    `).get("ws_org_share")).toEqual({ target_key: "org:org_team", granted_to_org_id: "org_team" })
    await expect(authority.openWorkspace(other, { workspaceId: "ws_org_share" }))
      .resolves.toMatchObject({ role: "editor" })

    await expect(authority.revokeWorkspaceShare(owner, {
      workspaceId: "ws_org_share",
      target: { kind: "org", orgId: "org_team" },
    })).resolves.toMatchObject({ revoked: true })
    await expect(authority.openWorkspace(other, { workspaceId: "ws_org_share" }))
      .rejects.toMatchObject({ status: 403 })
    authority.close()
    database.close()
  })

  test("rejects user and organization share grants without an authoritative target", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_unknown_share", displayName: "Unknown share" })

    await expect(authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_unknown_share",
      role: "viewer",
      target: { kind: "actor", actorId: "unknown-token" },
    })).rejects.toThrow("Share target not found")
    await expect(authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_unknown_share",
      role: "viewer",
      target: { kind: "org", orgId: "unknown-org" },
    })).rejects.toThrow("Share target not found")
  })

  test("usersMe/resolveOrgId mint a stable personal org", async () => {
    const authority = memoryAuthority()
    const me = await authority.usersMe(owner) as { org_id: string; token_identifier: string }
    expect(me.token_identifier).toBe(owner.user.tokenIdentifier)
    expect(me.org_id).toMatch(/^org_/)
    expect(await authority.resolveOrgId(owner)).toBe(me.org_id)
    expect(await authority.resolveOrgId(owner)).toBe(me.org_id)
    expect(await authority.resolveOrgId(other)).not.toBe(me.org_id)
  })

  test("runtime access tokens: record, active checks, revoke", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_rt", displayName: "RT" })
    const expiresAt = Date.now() + 60_000

    await expect(authority.recordRuntimeAccessToken(owner, {
      jti: "jti_wrong_actor",
      workspaceId: "ws_rt",
      hostId: "host_a",
      actorId: other.user.tokenIdentifier,
      actorKind: "human",
      role: "owner",
      expiresAt,
    })).rejects.toThrow("Workspace authority denied workspace access")

    await authority.recordRuntimeAccessToken(owner, {
      jti: "jti_1",
      workspaceId: "ws_rt",
      hostId: "host_a",
      actorId: owner.user.tokenIdentifier,
      actorKind: "human",
      role: "owner",
      expiresAt,
    })
    await expect(authority.recordRuntimeAccessToken(owner, {
      jti: "jti_1",
      workspaceId: "ws_rt",
      hostId: "host_a",
      actorId: owner.user.tokenIdentifier,
      actorKind: "human",
      role: "owner",
      expiresAt,
    })).rejects.toThrow("Runtime Access Token already recorded")

    await expect(authority.recordRuntimeAccessTokenForService({
      jti: "jti_service_wrong_kind",
      workspaceId: "ws_rt",
      hostId: "host_a",
      actorId: owner.user.tokenIdentifier,
      actorKind: "agent",
      principalKind: "user",
      role: "owner",
      expiresAt,
    })).rejects.toThrow("Workspace authority denied workspace access")
    await authority.recordRuntimeAccessTokenForService({
      jti: "jti_service",
      workspaceId: "ws_rt",
      hostId: "host_a",
      actorId: owner.user.tokenIdentifier,
      actorKind: "human",
      principalKind: "user",
      role: "owner",
      expiresAt,
    })
    await authority.recordRuntimeAccessTokenForService({
      jti: "jti_control_plane",
      workspaceId: "ws_rt",
      hostId: "host_a",
      actorId: "control-plane",
      actorKind: "agent",
      principalKind: "service",
      role: "owner",
      expiresAt,
    })
    await expect(authority.recordRuntimeAccessTokenForService({
      jti: "jti_service_editor",
      workspaceId: "ws_rt",
      hostId: "host_a",
      actorId: "control-plane",
      actorKind: "agent",
      principalKind: "service",
      role: "editor",
      expiresAt,
    })).rejects.toThrow("Workspace authority denied workspace access")

    expect(await authority.runtimeAccessTokenActive({ jti: "jti_1", workspaceId: "ws_rt", hostId: "host_a" }))
      .toEqual({ active: true })
    expect(await authority.runtimeAccessTokenActive({ jti: "jti_service", workspaceId: "ws_rt", hostId: "host_a" }))
      .toEqual({ active: true })
    expect(await authority.runtimeAccessTokenActive({ jti: "jti_control_plane", workspaceId: "ws_rt", hostId: "host_a" }))
      .toEqual({ active: true })
    expect(await authority.runtimeAccessTokenActive({ jti: "jti_1", workspaceId: "ws_rt", hostId: "host_b" }))
      .toMatchObject({ active: false, code: "runtime_access_token_mismatch" })
    expect(await authority.runtimeAccessTokenActive({ jti: "jti_missing", workspaceId: "ws_rt", hostId: "host_a" }))
      .toMatchObject({ active: false, code: "runtime_access_token_unknown" })

    await authority.revokeRuntimeAccessToken(owner, { jti: "jti_1", workspaceId: "ws_rt" })
    expect(await authority.runtimeAccessTokenActive({ jti: "jti_1", workspaceId: "ws_rt", hostId: "host_a" }))
      .toMatchObject({ active: false, code: "runtime_access_token_revoked" })
    await authority.deleteWorkspace(owner, { workspaceId: "ws_rt" })
    expect(await authority.runtimeAccessTokenActive({ jti: "jti_control_plane", workspaceId: "ws_rt", hostId: "host_a" }))
      .toMatchObject({ active: false, code: "runtime_access_token_revoked" })
  })

  test("live token checks reject a stale elevated role even if revocation stamping is missed", async () => {
    const { authority, database } = fileAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_role_downgrade", displayName: "Role downgrade" })
    await authority.usersMe(other)
    await authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_role_downgrade",
      role: "editor",
      target: { kind: "actor", actorId: other.user.tokenIdentifier },
    })
    await authority.recordRuntimeAccessToken(other, {
      jti: "jti_stale_editor",
      workspaceId: "ws_role_downgrade",
      hostId: "host_role_downgrade",
      actorId: other.user.tokenIdentifier,
      actorKind: "human",
      role: "editor",
      expiresAt: Date.now() + 60_000,
    })

    await authority.grantWorkspaceShare(owner, {
      workspaceId: "ws_role_downgrade",
      role: "viewer",
      target: { kind: "actor", actorId: other.user.tokenIdentifier },
    })
    database().prepare("UPDATE runtime_access_tokens SET revoked_at = NULL WHERE jti = ?").run("jti_stale_editor")

    await expect(authority.runtimeAccessTokenActive({
      jti: "jti_stale_editor",
      workspaceId: "ws_role_downgrade",
      hostId: "host_role_downgrade",
    })).resolves.toMatchObject({
      active: false,
      code: "runtime_access_token_revoked",
      reason: "Runtime Access Token authorization has changed",
    })
    authority.close()
    database.close()
  })

  test("agent extensions: admin-gated writes, runtime list without auth, source conflict", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_ext", displayName: "Ext" })

    await authority.upsertWorkspaceAgentExtension(owner, {
      workspaceId: "ws_ext",
      extensionId: "ext_1",
      packageName: "@acme/tool",
      desired: { id: "ext_1", enabled: true, source: { type: "github", owner: "acme", repo: "tool" } },
      lock: { version: "1.0.0" },
    })
    const forRuntime = await authority.listWorkspaceAgentExtensionsForRuntime({ workspaceId: "ws_ext" }) as Array<{
      enabled: boolean
      desired: { id: string }
    }>
    expect(forRuntime).toHaveLength(1)
    expect(forRuntime[0]).toMatchObject({ enabled: true })
    expect(forRuntime[0]!.desired).toMatchObject({ id: "ext_1" })

    await expect(authority.upsertWorkspaceAgentExtension(owner, {
      workspaceId: "ws_ext",
      extensionId: "ext_1",
      packageName: "@acme/tool",
      desired: { id: "ext_1", enabled: true, source: { type: "github", owner: "evil", repo: "tool" } },
      lock: {},
    })).rejects.toThrow("Agent Extension is already installed from a different source")

    await expect(authority.upsertWorkspaceAgentExtension(other, {
      workspaceId: "ws_ext",
      extensionId: "ext_2",
      packageName: "@acme/other",
      desired: { id: "ext_2", enabled: true },
      lock: {},
    })).rejects.toThrow("Workspace not found")

    await authority.setWorkspaceAgentExtensionEnabled(owner, { workspaceId: "ws_ext", extensionId: "ext_1", enabled: false })
    const disabled = await authority.listWorkspaceAgentExtensions(owner, { workspaceId: "ws_ext" }) as Array<{ enabled: boolean }>
    expect(disabled[0]).toMatchObject({ enabled: false })

    await authority.setAgentExtensionPolicyOverride(owner, {
      workspaceId: "ws_ext",
      extensionId: "ext_1",
      scope: "workspace",
      enabled: false,
      reason: "blocked",
    })
    expect(await authority.listAgentExtensionPolicyOverridesForRuntime({ workspaceId: "ws_ext" })).toEqual([
      { id: "ext_1", scope: "workspace", enabled: false, reason: "blocked" },
    ])

    // A soft-deleted row no longer guards its source: uninstalling and then
    // installing the same id from a different source revives the row instead
    // of rejecting (absorbed legacy records leave the same tombstones).
    await authority.deleteWorkspaceAgentExtension(owner, { workspaceId: "ws_ext", extensionId: "ext_1" })
    await authority.upsertWorkspaceAgentExtension(owner, {
      workspaceId: "ws_ext",
      extensionId: "ext_1",
      packageName: "@other/tool",
      desired: { id: "ext_1", enabled: true, source: { type: "github", owner: "other", repo: "tool" } },
      lock: {},
    })
    const revived = await authority.listWorkspaceAgentExtensions(owner, { workspaceId: "ws_ext" }) as Array<{
      desired: { source: { owner: string } }
    }>
    expect(revived).toHaveLength(1)
    expect(revived[0]!.desired.source).toMatchObject({ owner: "other" })
  })

  test("session visibility + message sync stay workspace-scoped", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_s", displayName: "S" })
    await registerPrivateSession({ authority, auth: owner, workspaceId: "ws_s", sessionId: "ses_1", title: "First" })
    await authority.upsertSessionVisibility(owner, {
      workspaceId: "ws_s",
      sessions: [{ sessionId: "ses_1", title: "First" }],
    })
    await authority.authorizeSessionRead(owner, { sessionId: "ses_1", workspaceId: "ws_s" })
    await expect(authority.authorizeSessionRead(other, { sessionId: "ses_1", workspaceId: "ws_s" }))
      .rejects.toMatchObject({ status: 403 })

    const fencingToken = await recordUserTurns({
      authority,
      auth: owner,
      workspaceId: "ws_s",
      sessionId: "ses_1",
      turnIds: ["msg_1"],
    })
    await authority.syncSessionMessages(owner, {
      sessionId: "ses_1",
      workspaceId: "ws_s",
      messages: [{ info: { id: "msg_1", role: "user" }, parts: [] }],
      fencingToken,
    })
    const read = await authority.readSessionMessages(owner, { sessionId: "ses_1", workspaceId: "ws_s" }) as {
      allowed: boolean
      messages: unknown[]
    }
    expect(read.allowed).toBe(true)
    expect(read.messages).toEqual([{
      info: {
        id: "msg_1",
        role: "user",
        claxedo: {
          author: {
            id: owner.user.tokenIdentifier,
            kind: "human",
          },
        },
      },
      parts: [],
    }])

    await authority.replaceSessionVisibility(owner, { workspaceId: "ws_s", sessions: [] })
    expect(await authority.listSessions(owner, { workspaceId: "ws_s" })).toEqual([])
  })

  test("pages workspace-authority transcripts backward without changing the legacy full read", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_page", displayName: "Paged" })
    await registerPrivateSession({ authority, auth: owner, workspaceId: "ws_page", sessionId: "ses_page" })
    await registerPrivateSession({ authority, auth: owner, workspaceId: "ws_page", sessionId: "ses_other" })
    await authority.upsertSessionVisibility(owner, {
      workspaceId: "ws_page",
      sessions: [{ sessionId: "ses_page" }, { sessionId: "ses_other" }],
    })
    const messages = Array.from({ length: 5 }, (_, index) => ({
      info: { id: `msg_${index + 1}`, role: index % 2 === 0 ? "user" : "assistant" },
      parts: [],
    }))
    const fencingToken = await recordUserTurns({
      authority,
      auth: owner,
      workspaceId: "ws_page",
      sessionId: "ses_page",
      turnIds: ["msg_1", "msg_3", "msg_5"],
    })
    await authority.syncSessionMessages(owner, {
      sessionId: "ses_page",
      workspaceId: "ws_page",
      messages,
      maxEventOrdinal: 10,
      fencingToken,
    })

    const first = await authority.readSessionMessages(owner, {
      sessionId: "ses_page",
      workspaceId: "ws_page",
      limit: 2,
    }) as { messages: typeof messages; nextCursor?: string }
    expect(first.messages.map((message) => message.info.id)).toEqual(["msg_4", "msg_5"])
    expect(first.nextCursor).toMatch(/^sawmp1:/)

    const second = await authority.readSessionMessages(owner, {
      sessionId: "ses_page",
      workspaceId: "ws_page",
      limit: 2,
      before: first.nextCursor,
    }) as { messages: typeof messages; nextCursor?: string }
    expect(second.messages.map((message) => message.info.id)).toEqual(["msg_2", "msg_3"])
    expect(second.nextCursor).toMatch(/^sawmp1:/)

    await expect(authority.readSessionMessages(owner, {
      sessionId: "ses_other",
      workspaceId: "ws_page",
      limit: 2,
      before: first.nextCursor,
    })).rejects.toMatchObject({ status: 400, message: "Invalid message page cursor" })

    await expect(authority.readSessionMessages(owner, {
      sessionId: "ses_page",
      workspaceId: "ws_page",
    })).resolves.toMatchObject({ messages })
  })

  test("session message sync atomically rejects an older event ordinal", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_ordinal", displayName: "Ordinal" })
    await registerPrivateSession({ authority, auth: owner, workspaceId: "ws_ordinal", sessionId: "ses_ordinal" })
    await authority.upsertSessionVisibility(owner, {
      workspaceId: "ws_ordinal",
      sessions: [{ sessionId: "ses_ordinal" }],
    })
    const newer = [{ info: { id: "msg_new", role: "assistant" }, parts: [] }]
    const older = [{ info: { id: "msg_old", role: "assistant" }, parts: [] }]

    await expect(authority.syncSessionMessages(owner, {
      workspaceId: "ws_ordinal",
      sessionId: "ses_ordinal",
      messages: newer,
      maxEventOrdinal: 12,
    })).resolves.toMatchObject({ ok: true, applied: true, maxEventOrdinal: 12 })
    await expect(authority.syncSessionMessages(owner, {
      workspaceId: "ws_ordinal",
      sessionId: "ses_ordinal",
      messages: older,
      maxEventOrdinal: 11,
    })).resolves.toMatchObject({ ok: true, applied: false, maxEventOrdinal: 12 })

    await expect(authority.readSessionMessages(owner, {
      workspaceId: "ws_ordinal",
      sessionId: "ses_ordinal",
    })).resolves.toMatchObject({ messages: newer })
  })

  test("rolls back a visibility batch when a later session belongs to another workspace", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_batch_a", displayName: "A" })
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_batch_b", displayName: "B" })
    await registerPrivateSession({
      authority,
      auth: owner,
      workspaceId: "ws_batch_b",
      sessionId: "ses_conflict",
      title: "Conflict",
    })
    await registerPrivateSession({
      authority,
      auth: owner,
      workspaceId: "ws_batch_a",
      sessionId: "ses_should_rollback",
      title: "Original",
    })
    await authority.upsertSessionVisibility(owner, {
      workspaceId: "ws_batch_b",
      sessions: [{ sessionId: "ses_conflict", title: "Conflict" }],
    })

    await expect(authority.upsertSessionVisibility(owner, {
      workspaceId: "ws_batch_a",
      sessions: [
        { sessionId: "ses_should_rollback", title: "Transient" },
        { sessionId: "ses_conflict", title: "Conflict" },
      ],
    })).rejects.toMatchObject({ status: 403 })
    expect(await authority.resolveSession(owner, { sessionId: "ses_should_rollback" }))
      .toMatchObject({ title: "Original" })
  })

  test("rolls back visibility tombstones when message deletion fails", async () => {
    const { authority, database } = fileAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_delete_rollback", displayName: "Delete" })
    await registerPrivateSession({
      authority,
      auth: owner,
      workspaceId: "ws_delete_rollback",
      sessionId: "ses_delete_rollback",
      title: "Keep",
    })
    await authority.upsertSessionVisibility(owner, {
      workspaceId: "ws_delete_rollback",
      sessions: [{ sessionId: "ses_delete_rollback", title: "Keep" }],
    })
    const fencingToken = await recordUserTurns({
      authority,
      auth: owner,
      workspaceId: "ws_delete_rollback",
      sessionId: "ses_delete_rollback",
      turnIds: ["msg_keep"],
    })
    await authority.syncSessionMessages(owner, {
      sessionId: "ses_delete_rollback",
      workspaceId: "ws_delete_rollback",
      messages: [{ info: { id: "msg_keep", role: "user" }, parts: [] }],
      fencingToken,
    })
    database().exec(`
      CREATE TRIGGER fail_message_delete BEFORE DELETE ON session_messages
      BEGIN SELECT RAISE(FAIL, 'forced message-delete failure'); END
    `)

    await expect(authority.replaceSessionVisibility(owner, {
      workspaceId: "ws_delete_rollback",
      sessions: [],
    })).rejects.toThrow("forced message-delete failure")
    expect(await authority.listSessions(owner, { workspaceId: "ws_delete_rollback" }))
      .toEqual([expect.objectContaining({ session_id: "ses_delete_rollback" })])

    await expect(authority.deleteSessionVisibility(owner, {
      workspaceId: "ws_delete_rollback",
      sessionId: "ses_delete_rollback",
    })).rejects.toThrow("forced message-delete failure")
    expect(await authority.readSessionMessages(owner, {
      workspaceId: "ws_delete_rollback",
      sessionId: "ses_delete_rollback",
    })).toMatchObject({ messages: [{ info: { id: "msg_keep", role: "user" }, parts: [] }] })
  })

  test("channel authorization denies without an identity mapping", async () => {
    const authority = memoryAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId: "ws_ch", displayName: "Ch" })
    expect(await authority.authorizeChannelProject({
      channel: "telegram",
      externalUserId: "tg_1",
      threadKey: "t_1",
      projectId: "prj_ws_ch",
      action: "read",
    })).toEqual({ ok: false })
    await expect(authority.authorizeChannelWorkspace({
      channel: "telegram",
      externalUserId: "tg_1",
      threadKey: "t_1",
      workspaceId: "ws_ch",
      action: "read",
    })).rejects.toMatchObject({ status: 403 })
  })

  test("the synthetic local identity is the degenerate single-user case", async () => {
    const authority = memoryAuthority()
    const local = localControlPlaneAuth()
    expect(local.user).toMatchObject({ subject: "local", tokenIdentifier: "local:default" })
    await authority.registerLocalForSharing(local, { workspaceId: "ws_home", displayName: "Home" })
    const listed = await authority.listWorkspaces(local) as Array<{ workspace_id: string; role: string }>
    expect(listed).toEqual([expect.objectContaining({ workspace_id: "ws_home", role: "owner" })])
  })
})

describe("sqlite workspace authority store transactions", () => {
  test("rolls back personal org and project parents when membership persistence fails", () => {
    const database = openAuthorityDb({ path: ":memory:" })
    const user = upsertUser(database(), { token_identifier: "user_store", subject: "user_store" })
    database().exec(`
      CREATE TRIGGER fail_org_membership BEFORE INSERT ON org_memberships
      BEGIN SELECT RAISE(FAIL, 'forced org-membership failure'); END
    `)

    expect(() => ensurePersonalOrg(database(), user)).toThrow("forced org-membership failure")
    expect(database().prepare("SELECT org_id FROM orgs").all()).toEqual([])

    database().exec("DROP TRIGGER fail_org_membership")
    const orgId = ensurePersonalOrg(database(), user)
    database().exec(`
      CREATE TRIGGER fail_project_membership BEFORE INSERT ON project_memberships
      BEGIN SELECT RAISE(FAIL, 'forced project-membership failure'); END
    `)

    expect(() => ensureProject(database(), {
      projectId: "prj_rollback",
      orgId,
      repoKey: "workspace:prj_rollback",
      owner: user,
    }))
      .toThrow("forced project-membership failure")
    expect(database().prepare("SELECT project_id FROM projects WHERE project_id = ?").get("prj_rollback"))
      .toBeUndefined()
  })
})

describe("default local composition", () => {
  test("local mode uses SQLite even when an ambient the authority URL is configured", async () => {
    const previous = {
      dataDir: process.env.CLAXEDO_DATA_DIR,
      deploymentMode: process.env.CLAXEDO_DEPLOYMENT_MODE,
      signed: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
      authorityUrl: process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL,
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-authority-"))
    process.env.CLAXEDO_DATA_DIR = dir
    process.env.CLAXEDO_DEPLOYMENT_MODE = "local"
    delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH
    process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = "http://127.0.0.1:1"
    try {
      const { createDefaultLocalControlPlaneServices } = await import("../../../deployments/self-hosted-node/app")
      const services = createDefaultLocalControlPlaneServices()
      try {
        // Local trust owns local storage. A stale hosted-development URL must not
        // turn the offline desktop/server into an authority client.
        expect(services.authority).toBeDefined()
        await expect(services.authority!.listWorkspaces(localControlPlaneAuth())).resolves.toEqual([])
      } finally {
        services.close()
      }
    } finally {
      for (const [key, value] of [
        ["CLAXEDO_DATA_DIR", previous.dataDir],
        ["CLAXEDO_DEPLOYMENT_MODE", previous.deploymentMode],
        ["CLAXEDO_SIGNED_CLOUD_AUTH", previous.signed],
        ["CLAXEDO_WORKSPACE_AUTHORITY_URL", previous.authorityUrl],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      // Close the authority handle the composition opened under dir before
      // deleting it: Windows answers an unlink of an open file with EBUSY.
      const { closeAuthorityDatabases } = await import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store")
      const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
      closeAuthorityDatabases()
      ClaxedoDB.close()
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})
