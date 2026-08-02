import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "../../auth"
import type { OrgId, ProjectAction, ProjectRoleResult, WorkspaceAuthority } from "../../authority"
import { randomToken } from "../../web-crypto"
import {
  authorizeProjectForUser,
  authorizeWorkspaceForUser,
  ensurePersonalOrg,
  ensureProject,
  openAuthorityDb,
  projectByPublicId,
  projectRoleForUser,
  upsertUser,
  userBySubject,
  workspaceByPublicId,
  workspaceRoleForUser,
  type AuthorityUser,
  type ProjectRow,
  type SqliteAuthorityDb,
  type SqliteWorkspaceAuthorityOptions,
  type WorkspaceAction,
  type WorkspaceRow,
} from "./workspace-authority-store"

// Claxedo's LOCAL workspace-authority adapter: the full `WorkspaceAuthority`
// port backed by a local SQLite database instead of Convex. This is the
// self-host enabler — a deployment with NO Convex/Clerk env composes this
// authority so `requireAuthority` never fails 503 and workspace/session
// features work out of the box. Per-method semantics mirror the Convex
// backend functions (convex/workspaces.ts, convex/localHostLinks.ts, ...).
// Node-only (better-sqlite3 via the store): hosted/Worker compositions must
// never import this module (worker.import-graph guard).

/**
 * The ONE seam where unsigned-local mode gets an identity.
 *
 * Routes only ever hand the authority a `SignedControlPlaneAuth`; in
 * unsigned-local mode `routeAuth` yields `undefined` and auth-guarded call
 * sites skip the authority entirely. Callers that want the local single-user
 * to act against this authority (composition roots, session pull flows, tests)
 * construct the synthetic identity HERE — never inline — so the stable
 * subject/tokenIdentifier pair exists in exactly one place.
 */
export function localControlPlaneAuth(): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: "",
    user: {
      subject: "local",
      tokenIdentifier: "local:default",
      issuer: "claxedo-local",
    },
  }
}

// Mirrors convex/localHostLinks.ts TTL policy.
const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 5 * 60_000
const CHALLENGE_TTL_MS = 60_000

function ttl(input?: number) {
  if (!input || !Number.isFinite(input)) return DEFAULT_TTL_MS
  return Math.max(5_000, Math.min(input, MAX_TTL_MS))
}

function base64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url")
}

function registrationPayload(input: {
  workspace_id: string
  host_id: string
  challenge_id: string
  nonce: string
}) {
  return [
    "claxedo.local-host-link.register.v1",
    `workspace_id=${input.workspace_id}`,
    `host_id=${input.host_id}`,
    `challenge_id=${input.challenge_id}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

function heartbeatPayload(input: {
  workspace_id: string
  host_id: string
  ttl_ms?: number
}) {
  return [
    "claxedo.local-host-link.heartbeat.v1",
    `workspace_id=${input.workspace_id}`,
    `host_id=${input.host_id}`,
    `ttl_ms=${input.ttl_ms ?? ""}`,
  ].join("\n")
}

async function verifyHostSignature(input: {
  public_key: string
  payload: string
  signature: string
}) {
  const jwk = JSON.parse(input.public_key)
  if (jwk?.kty !== "EC" || jwk?.crv !== "P-256") throw new Error("Invalid host public key")
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  )
  if (!await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(input.signature, "base64url"),
    new TextEncoder().encode(input.payload),
  )) {
    throw new Error("Invalid host attestation")
  }
}

function refuseCloudWorkspace(workspace: { backing?: unknown; access?: unknown }) {
  if (workspace.backing === "cloud-vm" || workspace.access === "cloud") {
    throw new Error("workspace_backing_conflict: cannot attach a local host link to a cloud workspace")
  }
}

// Mirrors `KNOWN_HOME_REGIONS` in convex/workspaces.ts: validate only, never default.
const KNOWN_HOME_REGIONS = ["apac-south", "apac-east", "eu-west", "us-east", "us-west"]

function validatedHomeRegion(input?: string) {
  if (input === undefined) return undefined
  if (!KNOWN_HOME_REGIONS.includes(input)) {
    throw new Error(`home_region_invalid: ${input} is not a known Claxedo region`)
  }
  return input
}

function defaultProjectId(workspaceId: string) {
  return `prj_${workspaceId}`
}

function denied(): never {
  throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Workspace authority denied workspace access")
}

function object(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function sourceKey(input: unknown) {
  const source = object(input)
  if (!source) return
  return JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))))
}

function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function jsonText(input: unknown) {
  try {
    return JSON.stringify(input) ?? "null"
  } catch {
    return "null"
  }
}

function workspaceJson(workspace: WorkspaceRow) {
  return {
    workspace_id: workspace.workspace_id,
    org_id: workspace.org_id ?? undefined,
    project_id: workspace.project_id ?? undefined,
    backing: workspace.backing,
    access: workspace.access,
    home_region: workspace.home_region ?? undefined,
    display_name: workspace.display_name ?? undefined,
    repo_url: workspace.repo_url ?? undefined,
    repo_name: workspace.repo_name ?? undefined,
    git_branch: workspace.git_branch ?? undefined,
  }
}

type HostLinkRow = {
  workspace_id: string
  host_id: string
  public_key: string
  display_name: string | null
  second_device_open_at: number | null
  last_seen_at: number
  expires_at: number
  paused_at: number | null
  revoked_at: number | null
}

type SessionVisibility = {
  sessionId: string
  title?: string
  createdAt?: number
  updatedAt?: number
}

export function createSqliteWorkspaceAuthority(options: SqliteWorkspaceAuthorityOptions = {}): WorkspaceAuthority {
  const database = openAuthorityDb(options)

  const user = (auth: SignedControlPlaneAuth): AuthorityUser => {
    const db = database()
    return upsertUser(db, {
      token_identifier: auth.user.tokenIdentifier,
      subject: auth.user.subject,
      issuer: auth.user.issuer,
      kind: auth.tokenKind === "cli" ? "agent" : "human",
    })
  }

  const requireWorkspace = (db: SqliteAuthorityDb, who: AuthorityUser, workspaceId: string, action: WorkspaceAction) => {
    const workspace = workspaceByPublicId(db, workspaceId)
    if (!workspace || workspace.deleted_at || !authorizeWorkspaceForUser(db, workspace, who, action)) {
      throw new Error("Workspace not found")
    }
    return workspace
  }

  const ownedProject = (db: SqliteAuthorityDb, who: AuthorityUser, input: {
    workspaceId: string
    projectId?: string
  }) => {
    const orgId = ensurePersonalOrg(db, who)
    const projectId = ensureProject(db, {
      projectId: input.projectId ?? defaultProjectId(input.workspaceId),
      orgId,
      owner: who,
    })
    return { orgId, projectId }
  }

  const revokeRuntimeTokensForUsers = (db: SqliteAuthorityDb, workspaceId: string, tokenIdentifiers: string[]) => {
    if (!tokenIdentifiers.length) return 0
    const now = Date.now()
    let revoked = 0
    for (const tokenIdentifier of tokenIdentifiers) {
      revoked += db.prepare(`
        UPDATE runtime_access_tokens SET revoked_at = ?
        WHERE workspace_id = ? AND minted_for_token_identifier = ? AND revoked_at IS NULL
      `).run(now, workspaceId, tokenIdentifier).changes
    }
    return revoked
  }

  const policyRows = (db: SqliteAuthorityDb, input: {
    workspace: WorkspaceRow
    userKey?: string
  }) => {
    const keys: Array<{ scope: string; key: string }> = [
      ...(input.workspace.org_id ? [{ scope: "org", key: input.workspace.org_id }] : []),
      ...(input.userKey ? [{ scope: "user", key: input.userKey }] : []),
      { scope: "workspace", key: input.workspace.workspace_id },
    ]
    return keys.flatMap(({ scope, key }) =>
      db.prepare(`
        SELECT extension_id, scope, enabled, reason FROM agent_extension_policy_overrides
        WHERE scope = ? AND scope_key = ? AND deleted_at IS NULL
      `).all(scope, key) as Array<{ extension_id: string; scope: string; enabled: number; reason: string | null }>,
    ).map((row) => ({
      id: row.extension_id,
      scope: row.scope,
      enabled: !!row.enabled,
      ...(row.reason ? { reason: row.reason } : {}),
    }))
  }

  const policyScopeKey = (db: SqliteAuthorityDb, who: AuthorityUser, workspace: WorkspaceRow, scope: "org" | "user" | "workspace") => {
    if (scope === "org") {
      if (!workspace.org_id) throw new Error("Workspace has no org")
      return workspace.org_id
    }
    if (scope === "user") return who.token_identifier
    return workspace.workspace_id
  }

  const linkedChannelUser = (db: SqliteAuthorityDb, args: { channel: string; externalUserId: string }) => {
    const link = db.prepare(`
      SELECT token_identifier FROM channel_identities
      WHERE channel = ? AND external_user_id = ? AND revoked_at IS NULL
    `).get(args.channel, args.externalUserId) as { token_identifier: string } | undefined
    if (!link) return
    return db.prepare(`SELECT token_identifier, subject FROM users WHERE token_identifier = ?`)
      .get(link.token_identifier) as AuthorityUser | undefined
  }

  // Mirror of convex/projects.ts `authResult`: role (optionally action-gated)
  // + the org check; no role or no org → { ok: false }.
  const projectResultFor = (
    db: SqliteAuthorityDb,
    project: ProjectRow,
    who: AuthorityUser,
    input: { action?: ProjectAction; orgId?: string },
  ): ProjectRoleResult => {
    const role = input.action
      ? authorizeProjectForUser(db, project, who, input.action)
      : projectRoleForUser(db, project, who)
    if (!role || !project.org_id) return { ok: false }
    if (input.orgId && input.orgId !== project.org_id) return { ok: false }
    return { ok: true, role, orgId: project.org_id as OrgId }
  }

  const listAgentExtensions = (db: SqliteAuthorityDb, workspaceId: string) => {
    const rows = db.prepare(`
      SELECT desired, lock, enabled, updated_at FROM agent_extension_installs
      WHERE workspace_id = ? AND deleted_at IS NULL
      ORDER BY extension_id ASC
    `).all(workspaceId) as Array<{ desired: string; lock: string | null; enabled: number; updated_at: number }>
    return rows.map((row) => ({
      desired: JSON.parse(row.desired) as unknown,
      lock: row.lock === null ? undefined : JSON.parse(row.lock) as unknown,
      enabled: !!row.enabled,
      updated_at: row.updated_at,
    }))
  }

  const upsertVisibilityRows = (db: SqliteAuthorityDb, input: {
    who: AuthorityUser
    workspace: WorkspaceRow
    sessions: SessionVisibility[]
  }) => {
    for (const session of input.sessions) {
      const now = Date.now()
      const existing = db.prepare(`SELECT workspace_id FROM session_history WHERE session_id = ?`)
        .get(session.sessionId) as { workspace_id: string } | undefined
      if (existing && existing.workspace_id !== input.workspace.workspace_id) throw new Error("Session not found")
      if (existing) {
        db.prepare(`
          UPDATE session_history SET title = ?, updated_at = ?, deleted_at = NULL WHERE session_id = ?
        `).run(session.title ?? null, session.updatedAt ?? now, session.sessionId)
        continue
      }
      db.prepare(`
        INSERT INTO session_history (session_id, workspace_id, created_by_token_identifier, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        session.sessionId,
        input.workspace.workspace_id,
        input.who.token_identifier,
        session.title ?? null,
        session.createdAt ?? now,
        session.updatedAt ?? now,
      )
    }
  }

  const deleteMessageRows = (db: SqliteAuthorityDb, sessionId: string, workspaceId: string) => {
    db.prepare(`DELETE FROM session_messages WHERE session_id = ? AND workspace_id = ?`).run(sessionId, workspaceId)
  }

  return {
    // --- identity (convex/users.ts, convex/orgs.ts, convex/projects.ts) ----
    async usersMe(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      const orgId = ensurePersonalOrg(db, who)
      return {
        user_id: who.token_identifier,
        subject: who.subject,
        token_identifier: who.token_identifier,
        org_id: orgId,
      }
    },
    async listOrgs(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      ensurePersonalOrg(db, who)
      return db.prepare(`
        SELECT o.org_id, o.clerk_org_id, o.name, m.role FROM org_memberships m
        JOIN orgs o ON o.org_id = m.org_id
        WHERE m.token_identifier = ? AND o.deleted_at IS NULL
      `).all(who.token_identifier) as unknown[]
    },
    async resolveOrgId(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      if (auth.user.orgId) {
        const org = db.prepare(`
          SELECT o.org_id FROM orgs o
          JOIN org_memberships m ON m.org_id = o.org_id AND m.token_identifier = ?
          WHERE o.clerk_org_id = ? AND o.deleted_at IS NULL
        `).get(who.token_identifier, auth.user.orgId) as { org_id: string } | undefined
        if (org) return org.org_id as OrgId
      }
      return ensurePersonalOrg(db, who) as OrgId
    },
    async projectRole(auth: SignedControlPlaneAuth, args): Promise<ProjectRoleResult> {
      const db = database()
      const who = user(auth)
      const project = projectByPublicId(db, args.projectId)
      if (!project) return { ok: false }
      return projectResultFor(db, project, who, { orgId: args.orgId })
    },
    async authorizeProject(auth: SignedControlPlaneAuth, args): Promise<ProjectRoleResult> {
      const db = database()
      const who = user(auth)
      const project = projectByPublicId(db, args.projectId)
      if (!project) return { ok: false }
      return projectResultFor(db, project, who, { action: args.action, orgId: args.orgId })
    },
    async authorizeChannelProject(args): Promise<ProjectRoleResult> {
      const db = database()
      const who = linkedChannelUser(db, args)
      if (!who) return { ok: false }
      const project = projectByPublicId(db, args.projectId)
      if (!project) return { ok: false }
      return projectResultFor(db, project, who, { action: args.action })
    },
    async authorizeChannelWorkspace(args) {
      const db = database()
      const who = linkedChannelUser(db, args)
      if (!who) denied()
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, args.action)) denied()
    },

    // --- workspaces (convex/workspaces.ts, convex/workspaceShares.ts) ------
    async authorizeWorkspaceOpen(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || workspace.deleted_at || !authorizeWorkspaceForUser(db, workspace, who, "read")) denied()
    },
    async openWorkspace(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || workspace.deleted_at) denied()
      const role = authorizeWorkspaceForUser(db, workspace, who, "read")
      if (!role) denied()
      return {
        allowed: true,
        role,
        workspace: workspaceJson(workspace),
      }
    },
    async listWorkspaces(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      const rows = db.prepare(`SELECT * FROM workspaces WHERE deleted_at IS NULL`).all() as WorkspaceRow[]
      return rows
        .map((workspace) => ({
          workspace_id: workspace.workspace_id,
          display_name: workspace.display_name ?? undefined,
          backing: workspace.backing,
          access: workspace.access,
          remote_directory: workspace.remote_directory ?? undefined,
          role: workspaceRoleForUser(db, workspace, who),
        }))
        .filter((item) => !!item.role)
    },
    async registerLocalForSharing(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const { orgId, projectId } = ownedProject(db, who, args)
      const requestedHomeRegion = validatedHomeRegion(args.homeRegion)
      const now = Date.now()
      const existing = workspaceByPublicId(db, args.workspaceId)
      if (existing) {
        if (!authorizeWorkspaceForUser(db, existing, who, "admin")) throw new Error("Workspace not found")
        if (existing.backing === "cloud-vm" || existing.access === "cloud") {
          throw new Error("workspace_backing_conflict: cannot register a cloud workspace as a user-hosted local workspace")
        }
        const home_region = existing.home_region ?? requestedHomeRegion
        db.prepare(`
          UPDATE workspaces SET
            org_id = ?, owner_token_identifier = ?, project_id = ?,
            backing = 'local-worktree', access = 'user-hosted',
            home_region = COALESCE(?, home_region),
            display_name = ?,
            repo_url = COALESCE(?, repo_url),
            repo_name = COALESCE(?, repo_name),
            git_branch = COALESCE(?, git_branch),
            remote_directory = COALESCE(?, remote_directory),
            deleted_at = NULL,
            updated_at = ?
          WHERE workspace_id = ?
        `).run(
          orgId,
          who.token_identifier,
          projectId,
          home_region ?? null,
          args.displayName,
          args.repoUrl ?? null,
          args.repoName ?? null,
          args.gitBranch ?? null,
          args.remoteDirectory ?? null,
          now,
          args.workspaceId,
        )
        return { workspace_doc_id: args.workspaceId, workspace_id: args.workspaceId, home_region }
      }
      db.prepare(`
        INSERT INTO workspaces (
          workspace_id, org_id, project_id, owner_token_identifier, backing, access,
          display_name, home_region, repo_url, repo_name, git_branch, remote_directory,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'local-worktree', 'user-hosted', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        args.workspaceId,
        orgId,
        projectId,
        who.token_identifier,
        args.displayName,
        requestedHomeRegion ?? null,
        args.repoUrl ?? null,
        args.repoName ?? null,
        args.gitBranch ?? null,
        args.remoteDirectory ?? null,
        now,
        now,
      )
      return { workspace_doc_id: args.workspaceId, workspace_id: args.workspaceId, home_region: requestedHomeRegion }
    },
    async createCloudWorkspace(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const { orgId, projectId } = ownedProject(db, who, args)
      const home_region = validatedHomeRegion(args.homeRegion)
      const now = Date.now()
      db.prepare(`
        INSERT INTO workspaces (
          workspace_id, org_id, project_id, owner_token_identifier, backing, access,
          display_name, home_region, repo_url, repo_name, git_branch, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'cloud-vm', 'cloud', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        args.workspaceId,
        orgId,
        projectId,
        who.token_identifier,
        args.displayName,
        home_region ?? null,
        args.repoUrl ?? null,
        args.repoName ?? null,
        args.gitBranch ?? null,
        now,
        now,
      )
      return { workspace_doc_id: args.workspaceId }
    },
    async deleteWorkspace(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || workspace.deleted_at || !authorizeWorkspaceForUser(db, workspace, who, "owner")) {
        throw new Error("Workspace not found")
      }
      db.prepare(`UPDATE workspaces SET deleted_at = ?, updated_at = ? WHERE workspace_id = ?`)
        .run(Date.now(), Date.now(), args.workspaceId)
      return { deleted: true }
    },
    async grantWorkspaceShare(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      if (!args.grantedToTokenIdentifier && !args.grantedToClerkSubject && !args.grantedToClerkOrgId) {
        throw new Error("Share target not found")
      }
      const grantId = `grant_${randomToken()}`
      db.prepare(`
        INSERT INTO workspace_share_grants (
          grant_id, workspace_id, granted_to_token_identifier, granted_to_subject, granted_to_org_id,
          role, created_by_token_identifier, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        grantId,
        args.workspaceId,
        args.grantedToTokenIdentifier ?? null,
        args.grantedToClerkSubject ?? null,
        args.grantedToClerkOrgId ?? null,
        args.role,
        who.token_identifier,
        Date.now(),
      )
      return grantId
    },
    async revokeWorkspaceShare(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      const grants = db.prepare(`SELECT * FROM workspace_share_grants WHERE workspace_id = ?`)
        .all(args.workspaceId) as Array<{
          grant_id: string
          granted_to_token_identifier: string | null
          granted_to_subject: string | null
          granted_to_org_id: string | null
          revoked_at: number | null
        }>
      const grant = grants.find((item) => {
        if (args.grantId) return item.grant_id === args.grantId
        if (args.grantedToTokenIdentifier) return item.granted_to_token_identifier === args.grantedToTokenIdentifier
        if (args.grantedToClerkSubject) return item.granted_to_subject === args.grantedToClerkSubject
        if (args.grantedToClerkOrgId) return item.granted_to_org_id === args.grantedToClerkOrgId
        return false
      })
      if (!grant || grant.revoked_at) return { revoked: false }
      db.prepare(`UPDATE workspace_share_grants SET revoked_at = ? WHERE grant_id = ?`).run(Date.now(), grant.grant_id)
      const tokenIdentifiers = grant.granted_to_token_identifier
        ? [grant.granted_to_token_identifier]
        : grant.granted_to_subject
          ? [userBySubject(db, grant.granted_to_subject)?.token_identifier].filter((item): item is string => !!item)
          : grant.granted_to_org_id
            ? (db.prepare(`SELECT token_identifier FROM org_memberships WHERE org_id = ?`)
              .all(grant.granted_to_org_id) as Array<{ token_identifier: string }>)
              .map((item) => item.token_identifier)
            : []
      return {
        revoked: true,
        runtime_tokens_revoked: revokeRuntimeTokensForUsers(db, args.workspaceId, tokenIdentifiers),
      }
    },

    // --- local host links (convex/localHostLinks.ts) ------------------------
    async createLocalHostLinkChallenge(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      // A never-registered workspaceId may take a challenge; ownership is
      // established at register (after host proof). When the row EXISTS, the
      // admin/backing checks apply.
      if (workspace) {
        if (!authorizeWorkspaceForUser(db, workspace, who, "admin")) throw new Error("Workspace not found")
        refuseCloudWorkspace(workspace)
      }
      const now = Date.now()
      const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)))
      const challengeId = base64url(crypto.getRandomValues(new Uint8Array(16)))
      db.prepare(`
        INSERT INTO host_attestation_challenges (challenge_id, workspace_id, owner_token_identifier, host_id, nonce, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(challengeId, args.workspaceId, who.token_identifier, args.hostId, nonce, now + CHALLENGE_TTL_MS, now)
      return { challenge_id: challengeId, nonce, expires_at: now + CHALLENGE_TTL_MS }
    },
    async registerLocalHostLink(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const existingWorkspace = workspaceByPublicId(db, args.workspaceId)
      if (existingWorkspace) {
        if (!authorizeWorkspaceForUser(db, existingWorkspace, who, "admin")) throw new Error("Workspace not found")
        refuseCloudWorkspace(existingWorkspace)
      }
      const now = Date.now()
      const challenge = db.prepare(`SELECT * FROM host_attestation_challenges WHERE challenge_id = ?`)
        .get(args.challengeId) as {
          workspace_id: string
          owner_token_identifier: string
          host_id: string
          nonce: string
          expires_at: number
          used_at: number | null
        } | undefined
      if (
        !challenge
        || challenge.workspace_id !== args.workspaceId
        || challenge.owner_token_identifier !== who.token_identifier
        || challenge.host_id !== args.hostId
        || challenge.used_at
        || challenge.expires_at <= now
      ) {
        throw new Error("Invalid host attestation challenge")
      }
      await verifyHostSignature({
        public_key: args.publicKey,
        payload: registrationPayload({
          workspace_id: args.workspaceId,
          host_id: args.hostId,
          challenge_id: args.challengeId,
          nonce: challenge.nonce,
        }),
        signature: args.signature,
      })
      return db.transaction(() => {
        const claimedAt = Date.now()
        const claimed = db.prepare(`
          UPDATE host_attestation_challenges SET used_at = ?
          WHERE challenge_id = ? AND used_at IS NULL AND expires_at > ?
        `).run(claimedAt, args.challengeId, claimedAt)
        if (claimed.changes !== 1) throw new Error("Invalid host attestation challenge")

        const currentWorkspace = workspaceByPublicId(db, args.workspaceId)
        if (currentWorkspace) {
          if (!authorizeWorkspaceForUser(db, currentWorkspace, who, "admin")) throw new Error("Workspace not found")
          refuseCloudWorkspace(currentWorkspace)
        } else {
          db.prepare(`
            INSERT INTO workspaces (workspace_id, owner_token_identifier, backing, access, display_name, created_at, updated_at)
            VALUES (?, ?, 'local-worktree', 'user-hosted', ?, ?, ?)
          `).run(args.workspaceId, who.token_identifier, args.displayName ?? args.workspaceId, claimedAt, claimedAt)
        }
        const workspace = currentWorkspace ?? workspaceByPublicId(db, args.workspaceId)!
        const expiresAt = claimedAt + ttl(args.ttlMs)
        db.prepare(`
          INSERT INTO local_host_links (
            workspace_id, host_id, owner_token_identifier, public_key, display_name,
            last_seen_at, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, host_id) DO UPDATE SET
            public_key = excluded.public_key,
            display_name = excluded.display_name,
            last_seen_at = excluded.last_seen_at,
            expires_at = excluded.expires_at,
            paused_at = NULL,
            paused_by = NULL,
            paused_reason = NULL,
            revoked_at = NULL,
            updated_at = excluded.updated_at
        `).run(
          args.workspaceId,
          args.hostId,
          who.token_identifier,
          args.publicKey,
          args.displayName ?? null,
          claimedAt,
          expiresAt,
          claimedAt,
          claimedAt,
        )
        return {
          host_id: args.hostId,
          workspace_id: args.workspaceId,
          home_region: workspace.home_region ?? undefined,
          expires_at: expiresAt,
          paused: false,
        }
      })()
    },
    async heartbeatLocalHostLink(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "admin")
      const link = db.prepare(`SELECT * FROM local_host_links WHERE workspace_id = ? AND host_id = ?`)
        .get(args.workspaceId, args.hostId) as HostLinkRow | undefined
      if (!link || link.revoked_at) throw new Error("Local Host Link not found")
      if (!link.public_key) throw new Error("Host attestation required")
      await verifyHostSignature({
        public_key: link.public_key,
        payload: heartbeatPayload({
          workspace_id: args.workspaceId,
          host_id: args.hostId,
          ttl_ms: args.ttlMs,
        }),
        signature: args.signature,
      })
      const now = Date.now()
      const expiresAt = now + ttl(args.ttlMs)
      db.prepare(`
        UPDATE local_host_links SET last_seen_at = ?, expires_at = ?, updated_at = ?
        WHERE workspace_id = ? AND host_id = ?
      `).run(now, expiresAt, now, args.workspaceId, args.hostId)
      return {
        host_id: args.hostId,
        workspace_id: args.workspaceId,
        home_region: workspace.home_region ?? undefined,
        expires_at: expiresAt,
        paused: !!link.paused_at,
      }
    },
    async pauseLocalHostLink(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      const now = Date.now()
      const result = args.hostId
        ? db.prepare(`
            UPDATE local_host_links SET paused_at = ?, paused_by = ?, paused_reason = ?, updated_at = ?
            WHERE workspace_id = ? AND host_id = ?
          `).run(args.paused ? now : null, args.paused ? "user" : null, args.paused ? "user_paused" : null, now, args.workspaceId, args.hostId)
        : db.prepare(`
            UPDATE local_host_links SET paused_at = ?, paused_by = ?, paused_reason = ?, updated_at = ?
            WHERE workspace_id = ?
          `).run(args.paused ? now : null, args.paused ? "user" : null, args.paused ? "user_paused" : null, now, args.workspaceId)
      return {
        workspace_id: args.workspaceId,
        paused: args.paused,
        count: result.changes,
      }
    },
    async activeLocalHostLink(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "read")) return { active: false as const }
      const link = db.prepare(`
        SELECT * FROM local_host_links
        WHERE workspace_id = ? AND revoked_at IS NULL AND paused_at IS NULL AND expires_at > ?
        ORDER BY last_seen_at DESC LIMIT 1
      `).get(args.workspaceId, Date.now()) as HostLinkRow | undefined
      if (!link) return { active: false as const }
      return {
        active: true as const,
        host_id: link.host_id,
        workspace_id: args.workspaceId,
        ...(link.display_name ? { display_name: link.display_name } : {}),
        ...(link.second_device_open_at ? { second_device_open_at: link.second_device_open_at } : {}),
        expires_at: link.expires_at,
        last_seen_at: link.last_seen_at,
      }
    },
    async markSecondDeviceOpen(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "read")) denied()
      const now = Date.now()
      const result = db.prepare(`
        UPDATE local_host_links SET second_device_open_at = COALESCE(second_device_open_at, ?), updated_at = ?
        WHERE workspace_id = ? AND owner_token_identifier = ? AND revoked_at IS NULL
      `).run(now, now, args.workspaceId, who.token_identifier)
      return { recorded: result.changes > 0, second_device_open_at: now }
    },

    // --- sessions (convex/sessions.ts) --------------------------------------
    async authorizeSessionRead(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace) denied()
      const session = db.prepare(`SELECT workspace_id, deleted_at FROM session_history WHERE session_id = ?`)
        .get(args.sessionId) as { workspace_id: string; deleted_at: number | null } | undefined
      if (!session || session.workspace_id !== args.workspaceId || session.deleted_at) denied()
      if (!authorizeWorkspaceForUser(db, workspace, who, "read")) denied()
    },
    async listSessions(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "read")) return []
      return db.prepare(`
        SELECT session_id, title, created_at, updated_at FROM session_history
        WHERE workspace_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
      `).all(args.workspaceId) as unknown[]
    },
    async readSessionMessages(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const session = db.prepare(`SELECT workspace_id, deleted_at FROM session_history WHERE session_id = ?`)
        .get(args.sessionId) as { workspace_id: string; deleted_at: number | null } | undefined
      const role = workspace && session && session.workspace_id === args.workspaceId && !session.deleted_at
        ? authorizeWorkspaceForUser(db, workspace, who, "read")
        : undefined
      if (!role) return { allowed: false, messages: [] }
      const rows = db.prepare(`
        SELECT data FROM session_messages WHERE session_id = ? AND workspace_id = ? ORDER BY ordinal ASC
      `).all(args.sessionId, args.workspaceId) as Array<{ data: string }>
      return {
        allowed: true,
        role,
        messages: rows.map((row) => JSON.parse(row.data) as unknown),
      }
    },
    async syncSessionMessages(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "write")
      const existing = db.prepare(`SELECT workspace_id, deleted_at FROM session_history WHERE session_id = ?`)
        .get(args.sessionId) as { workspace_id: string; deleted_at: number | null } | undefined
      if (existing && existing.workspace_id !== args.workspaceId) throw new Error("Session not found")
      const now = Date.now()
      db.transaction(() => {
        if (existing) {
          if (existing.deleted_at) {
            db.prepare(`UPDATE session_history SET deleted_at = NULL WHERE session_id = ?`).run(args.sessionId)
          }
        } else {
          db.prepare(`
            INSERT INTO session_history (session_id, workspace_id, created_by_token_identifier, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(args.sessionId, workspace.workspace_id, who.token_identifier, now, now)
        }
        // Replace-all: observable read shape (ordered `data` payloads) matches
        // the Convex per-row diffing without carrying its patch bookkeeping.
        deleteMessageRows(db, args.sessionId, args.workspaceId)
        const insert = db.prepare(`
          INSERT INTO session_messages (session_id, workspace_id, message_id, role, ordinal, data, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (session_id, message_id) DO UPDATE SET
            role = excluded.role, ordinal = excluded.ordinal, data = excluded.data, updated_at = excluded.updated_at
        `)
        for (let ordinal = 0; ordinal < args.messages.length; ordinal += 1) {
          const message = args.messages[ordinal]
          const row = object(message)
          const info = object(row?.info)
          const messageId = txt(row?.id) ?? txt(info?.id) ?? `${args.sessionId}:${ordinal}`
          const role = txt(row?.role) ?? txt(info?.role) ?? null
          insert.run(args.sessionId, args.workspaceId, messageId, role, ordinal, jsonText(message), now, now)
        }
      })()
      return { ok: true }
    },
    async upsertSessionVisibility(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "write")
      db.transaction(() => {
        upsertVisibilityRows(db, { who, workspace, sessions: args.sessions })
      })()
      return { ok: true }
    },
    async replaceSessionVisibility(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "write")
      db.transaction(() => {
        upsertVisibilityRows(db, { who, workspace, sessions: args.sessions })
        const incoming = new Set(args.sessions.map((session) => session.sessionId))
        const now = Date.now()
        const rows = db.prepare(`SELECT session_id FROM session_history WHERE workspace_id = ? AND deleted_at IS NULL`)
          .all(args.workspaceId) as Array<{ session_id: string }>
        for (const row of rows.filter((item) => !incoming.has(item.session_id))) {
          db.prepare(`UPDATE session_history SET deleted_at = ?, updated_at = ? WHERE session_id = ?`)
            .run(now, now, row.session_id)
          deleteMessageRows(db, row.session_id, args.workspaceId)
        }
      })()
      return { ok: true }
    },
    async deleteSessionVisibility(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "write")
      const session = db.prepare(`SELECT workspace_id FROM session_history WHERE session_id = ?`)
        .get(args.sessionId) as { workspace_id: string } | undefined
      if (!session || session.workspace_id !== args.workspaceId) return { ok: true }
      db.transaction(() => {
        const now = Date.now()
        db.prepare(`UPDATE session_history SET deleted_at = ?, updated_at = ? WHERE session_id = ?`)
          .run(now, now, args.sessionId)
        deleteMessageRows(db, args.sessionId, args.workspaceId)
      })()
      return { ok: true }
    },

    // --- runtime tokens (convex/runtimeAccessTokens.ts) ---------------------
    async recordRuntimeAccessToken(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "read")
      const existing = db.prepare(`SELECT jti FROM runtime_access_tokens WHERE jti = ?`).get(args.jti)
      if (existing) throw new Error("Runtime Access Token already recorded")
      db.prepare(`
        INSERT INTO runtime_access_tokens (jti, workspace_id, host_id, minted_for_token_identifier, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(args.jti, args.workspaceId, args.hostId, who.token_identifier, args.expiresAt, Date.now())
      return { ok: true }
    },
    async recordRuntimeAccessTokenForService(args) {
      const db = database()
      const existing = db.prepare(`SELECT jti FROM runtime_access_tokens WHERE jti = ?`).get(args.jti)
      if (existing) throw new Error("Runtime Access Token already recorded")
      db.prepare(`
        INSERT INTO runtime_access_tokens (jti, workspace_id, host_id, minted_for_token_identifier, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(args.jti, args.workspaceId, args.hostId, args.subject, args.expiresAt, Date.now())
      return { ok: true }
    },
    async runtimeAccessTokenActive(args) {
      const db = database()
      const token = db.prepare(`SELECT * FROM runtime_access_tokens WHERE jti = ?`).get(args.jti) as {
        workspace_id: string
        host_id: string
        expires_at: number
        revoked_at: number | null
      } | undefined
      if (!token) {
        return { active: false, code: "runtime_access_token_unknown", reason: "Runtime Access Token has not been recorded" }
      }
      if (token.revoked_at) {
        return { active: false, code: "runtime_access_token_revoked", reason: "Runtime Access Token has been revoked" }
      }
      if (token.workspace_id !== args.workspaceId || token.host_id !== args.hostId) {
        return { active: false, code: "runtime_access_token_mismatch", reason: "Runtime Access Token does not match workspace or host" }
      }
      if (token.expires_at <= Date.now()) {
        return { active: false, code: "runtime_access_token_expired", reason: "Runtime Access Token has expired" }
      }
      return { active: true }
    },
    async revokeRuntimeAccessToken(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "read")
      db.prepare(`
        UPDATE runtime_access_tokens SET revoked_at = ?
        WHERE jti = ? AND workspace_id = ? AND revoked_at IS NULL
      `).run(Date.now(), args.jti, args.workspaceId)
      return { ok: true }
    },
    async revokeRuntimeAccessTokensForWorkspaceUser(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "read")
      return { revoked: revokeRuntimeTokensForUsers(db, args.workspaceId, [who.token_identifier]) }
    },

    // --- agent extensions (convex/agentExtensions.ts, ...Policies.ts) -------
    async listWorkspaceAgentExtensions(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "read")) return []
      return listAgentExtensions(db, args.workspaceId)
    },
    async listWorkspaceAgentExtensionsForRuntime(args) {
      // In-process trust boundary: the embedded runtime IS this server, so no
      // service token exists to check (the Convex variant gates on one).
      return listAgentExtensions(database(), args.workspaceId)
    },
    async authorizeWorkspaceAgentExtensionsAdmin(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "admin")) denied()
    },
    async upsertWorkspaceAgentExtension(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      const now = Date.now()
      // Only live rows guard the source: a soft-deleted row (uninstalled, or
      // absorbed into the pinned catalog id by the install route) must not
      // block a fresh install that legitimately reuses its id — the upsert
      // below revives the row under the new source.
      const existing = db.prepare(`SELECT desired FROM agent_extension_installs WHERE workspace_id = ? AND extension_id = ? AND deleted_at IS NULL`)
        .get(args.workspaceId, args.extensionId) as { desired: string } | undefined
      if (existing) {
        const existingSource = sourceKey(object(JSON.parse(existing.desired))?.source)
        const requestedSource = sourceKey(object(args.desired)?.source)
        if (existingSource && requestedSource && existingSource !== requestedSource) {
          throw new Error("Agent Extension is already installed from a different source")
        }
      }
      db.prepare(`
        INSERT INTO agent_extension_installs (workspace_id, extension_id, package_name, desired, lock, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, extension_id) DO UPDATE SET
          package_name = excluded.package_name,
          desired = excluded.desired,
          lock = excluded.lock,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `).run(
        args.workspaceId,
        args.extensionId,
        args.packageName,
        jsonText(args.desired),
        jsonText(args.lock),
        object(args.desired)?.enabled ? 1 : 0,
        now,
        now,
      )
      return { extension_id: args.extensionId }
    },
    async setWorkspaceAgentExtensionEnabled(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      const existing = db.prepare(`
        SELECT desired, deleted_at FROM agent_extension_installs WHERE workspace_id = ? AND extension_id = ?
      `).get(args.workspaceId, args.extensionId) as { desired: string; deleted_at: number | null } | undefined
      if (!existing || existing.deleted_at) throw new Error("Agent Extension not found")
      const now = Date.now()
      const desired = { ...(object(JSON.parse(existing.desired)) ?? {}), enabled: args.enabled, updated_at: now }
      db.prepare(`
        UPDATE agent_extension_installs SET enabled = ?, desired = ?, updated_at = ?
        WHERE workspace_id = ? AND extension_id = ?
      `).run(args.enabled ? 1 : 0, jsonText(desired), now, args.workspaceId, args.extensionId)
      return { extension_id: args.extensionId, enabled: args.enabled }
    },
    async deleteWorkspaceAgentExtension(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      db.prepare(`
        UPDATE agent_extension_installs SET deleted_at = ?, updated_at = ?
        WHERE workspace_id = ? AND extension_id = ? AND deleted_at IS NULL
      `).run(Date.now(), Date.now(), args.workspaceId, args.extensionId)
      return { ok: true }
    },
    async listAgentExtensionPolicyOverrides(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "read")) return []
      return policyRows(db, { workspace, userKey: who.token_identifier })
    },
    async listAgentExtensionPolicyOverridesForRuntime(args) {
      const db = database()
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace) return []
      return policyRows(db, { workspace })
    },
    async setAgentExtensionPolicyOverride(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "admin")
      const scopeKey = policyScopeKey(db, who, workspace, args.scope)
      const now = Date.now()
      db.prepare(`
        INSERT INTO agent_extension_policy_overrides (scope, scope_key, extension_id, enabled, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (scope, scope_key, extension_id) DO UPDATE SET
          enabled = excluded.enabled,
          reason = excluded.reason,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `).run(args.scope, scopeKey, args.extensionId, args.enabled ? 1 : 0, args.reason ?? null, now, now)
      return { extension_id: args.extensionId, scope: args.scope }
    },
    async deleteAgentExtensionPolicyOverride(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "admin")
      const scopeKey = policyScopeKey(db, who, workspace, args.scope)
      db.prepare(`
        UPDATE agent_extension_policy_overrides SET deleted_at = ?, updated_at = ?
        WHERE scope = ? AND scope_key = ? AND extension_id = ? AND deleted_at IS NULL
      `).run(Date.now(), Date.now(), args.scope, scopeKey, args.extensionId)
      return { ok: true }
    },

    // --- audit (convex/auditEvents.ts) ---------------------------------------
    async auditDeny(auth, args) {
      const db = database()
      db.prepare(`
        INSERT INTO audit_events (token_identifier, workspace_id, action, result, reason, metadata, created_at)
        VALUES (?, ?, ?, 'deny', ?, ?, ?)
      `).run(
        auth?.user.tokenIdentifier ?? null,
        args.workspaceId ?? null,
        args.action,
        args.reason,
        args.metadata ? jsonText(args.metadata) : null,
        Date.now(),
      )
    },
    async auditAllow(auth: SignedControlPlaneAuth, args) {
      const db = database()
      db.prepare(`
        INSERT INTO audit_events (token_identifier, workspace_id, action, result, reason, metadata, created_at)
        VALUES (?, ?, ?, 'allow', NULL, ?, ?)
      `).run(
        auth.user.tokenIdentifier,
        args.workspaceId ?? null,
        args.action,
        args.metadata ? jsonText(args.metadata) : null,
        Date.now(),
      )
    },
  }
}
